const EventEmitter = require("events").EventEmitter;
const ModbusRTU = require("modbus-serial");
const Logger = require("./Logger");

/**
 * Not implemented and not validated so far:
 * - Device Info: 31000 (Name), 30200-30204 (EMS/VMS/BMS Firmware), 30350 (Comm Firmware)
 * - Network Data: 30304 (MAC), 30300 (WiFi Status), 30303 (WiFi Signal), 30302 (Cloud Status)
 * - Daily/Monthly Accumulators: 33004 - 33010 (Charging/Discharging totals)
 * - Schedules (1-6): 43100 - 43129 (Days, Start, End, Mode, Enabled)
 */

class Poller {
    constructor() {
        this.eventEmitter = new EventEmitter();
        this.client = new ModbusRTU();
        this.connected = false;

        this.energyInOffset = parseFloat(process.env.ENERGY_IN_OFFSET) || 0;
        this.energyOutOffset = parseFloat(process.env.ENERGY_OUT_OFFSET) || 0;
    }

    async initialize() {
        if (!process.env.POLL_IP) {
            Logger.error("POLL_IP is not set.");
            process.exit(1);
        }

        const interval = Number(process.env.POLL_INTERVAL) || 5000;
        const port = Number(process.env.POLL_PORT) || 502;
        const slaveId = Number(process.env.SLAVE_ID) || 1;

        Logger.info(`Initializing Poller: ${process.env.POLL_IP}:${port} ID:${slaveId} Interval:${interval}ms`);
        if (this.energyInOffset !== 0 || this.energyOutOffset !== 0) {
            Logger.info(`Using Energy Offsets - In: ${this.energyInOffset} kWh, Out: ${this.energyOutOffset} kWh`);
        }

        const connect = async () => {
            try {
                if (this.client.isOpen) this.client.close();

                await this.client.connectTCP(process.env.POLL_IP, { port: port });
                this.client.setID(slaveId);
                this.client.setTimeout(2000);
                this.connected = true;
                Logger.info("Modbus connected");
            } catch (e) {
                Logger.error("Modbus connection failed:", e.message);
                this.connected = false;
            }
        };

        await connect();

        const pollingLoop = async () => {
            if (!this.connected) await connect();

            if (this.connected) {
                try {
                    await this.poll();
                } catch (err) {
                    Logger.warn("Error during poll cycle", err.message);
                    this.connected = false;
                }
            }

            setTimeout(() => {
                pollingLoop().catch(() => {});
            }, interval - (Date.now() % interval));
        };

        pollingLoop().catch(() => {});
    }

    async poll() {
        const data = {};

        const power = await this.readBlock(30001, 6);
        data.battery_power = power.readInt16BE(0);
        data.ac_power      = power.readInt16BE(10);

        const bat = await this.readBlock(30100, 2);
        data.battery_voltage = bat.readUInt16BE(0) * 0.01;
        data.battery_current = bat.readInt16BE(2) * 0.1;

        const bat_global = await this.readBlock(32104, 6);
        data.soc = bat_global.readUInt16BE(0);
        data.battery_design_capacity = bat_global.readUInt16BE(2) * 0.001;
        const moduleCount = bat_global.readUInt16BE(10);

        const ac = await this.readBlock(32200, 5);
        data.ac_voltage   = ac.readUInt16BE(0) * 0.1;
        data.ac_frequency = ac.readInt16BE(8) * 0.1;

        // FIXME: Validate. Does this require a minimum firmware version or is it just invalid?
        // const offgrid = await this.readBlock(32300, 4);
        // data.ac_offgrid_voltage = offgrid.readUInt16BE(0) * 0.1;
        // data.ac_offgrid_current = offgrid.readUInt16BE(2) * 0.01;
        // data.ac_offgrid_power   = offgrid.readInt32BE(4);

        const soc_block = await this.readBlock(37004, 5);
        data.ac_current = soc_block.readInt16BE(0) * 0.004;
        data.max_cell_voltage   = soc_block.readUInt16BE(6) * 0.001;
        data.min_cell_voltage   = soc_block.readUInt16BE(8) * 0.001;

        const nrg = await this.readBlock(33000, 4);
        data.total_energy_in  = (nrg.readUInt32BE(0) * 0.01) + this.energyInOffset;
        data.total_energy_out = (nrg.readInt32BE(4) * 0.01) + this.energyOutOffset;

        const temp = await this.readBlock(35000, 3);
        data.internal_temperature = temp.readInt16BE(0) * 0.1;
        data.internal_mos1_temperature = temp.readInt16BE(2) * 0.1;
        data.internal_mos2_temperature = temp.readInt16BE(4) * 0.1;

        const temp2 = await this.readBlock(35010, 2);
        data.max_cell_temperature = temp2.readInt16BE(0) * 0.1;
        data.min_cell_temperature = temp2.readInt16BE(2) * 0.1;

        data.inverter_state = (await this.readBlock(35100, 1)).readUInt16BE(0);
        data.backup_function = (await this.readBlock(41200, 1)).readUInt16BE(0);

        const ctrl1 = await this.readBlock(42010, 2);
        data.force_mode    = ctrl1.readUInt16BE(0);
        data.charge_to_soc = ctrl1.readUInt16BE(2);

        const ctrl2 = await this.readBlock(42020, 2);
        data.set_charge_power    = ctrl2.readUInt16BE(0);
        data.set_discharge_power = ctrl2.readUInt16BE(2);

        data.user_work_mode = (await this.readBlock(43000, 1)).readUInt16BE(0);
        data.rs485_control_mode = (await this.readBlock(42000, 1)).readUInt16BE(0);

        const mppt = await this.readBlock(30020, 21);
        for (let i = 1; i <= 4; i++) {
            data[`mppt${i}_voltage`] = mppt.readUInt16BE((i - 1) * 2) * 0.1;
            data[`mppt${i}_current`] = mppt.readUInt16BE((4 + (i - 1)) * 2) * 0.1;
            data[`mppt${i}_power`]   = mppt.readUInt16BE((17 + (i - 1)) * 2) * 0.1;
        }

        let totalHighResSoc = 0;
        let validModules = 0;

        for (let i = 1; i <= moduleCount; i++) {
            try {
                let base = 34000 + (i - 1) * 100;
                const modSoc = await this.readBlock(base + 2, 1);
                const highResSoc = modSoc.readUInt16BE(0) * 0.1;

                data[`battery_${i}_soc`] = highResSoc;

                totalHighResSoc += highResSoc;
                validModules++;

                const modCells = await this.readBlock(base + 18, 13);
                for (let c = 1; c <= 13; c++) {
                    data[`battery_${i}_cell_${c}_voltage`] = modCells.readInt16BE((c - 1) * 2) * 0.001;
                }
            } catch (err) {
                Logger.warn(`Failed to read module ${i} despite module count reporting ${moduleCount}`);
                break;
            }
        }

        if (validModules > 0) {
            const avgSoc = totalHighResSoc / validModules;
            data.remaining_energy = (avgSoc / 100) * data.battery_design_capacity;

            data.soc = avgSoc;
        } else {
            data.remaining_energy = (data.soc / 100) * data.battery_design_capacity;
        }

        this.emitData(data);
    }

    async readBlock(start, length) {
        const res = await this.client.readHoldingRegisters(start, length);
        return res.buffer;
    }

    async writeRegister(address, value) {
        if (!this.connected) throw new Error("Not connected");
        Logger.info(`Writing ${value} to register ${address}`);
        await this.client.writeRegister(address, value);
    }

    emitData(data) {
        this.eventEmitter.emit(Poller.EVENTS.Data, data);
    }

    onData(listener) {
        this.eventEmitter.on(Poller.EVENTS.Data, listener);
    }
}

Poller.EVENTS = { Data: "Data" };

Poller.CONTROLS = {
    "user_work_mode": { register: 43000, type: "select", map: { 0: "Manual", 1: "Self Consumption", 2: "Trade" } },
    "force_mode": { register: 42010, type: "select", map: { 0: "Stop", 1: "Charge", 2: "Discharge" } },
    "backup_function": { register: 41200, type: "switch", on: 0, off: 1 },
    "rs485_control_mode": { register: 42000, type: "switch", on: 21930, off: 21947 },
    "set_charge_power": { register: 42020, type: "number" },
    "set_discharge_power": { register: 42021, type: "number" },
    "charge_to_soc": { register: 42011, type: "number" },
    "reset_device": { register: 41000, type: "button", command: 21930 },
    "factory_reset": { register: 41001, type: "button", command: 21930 }
};

Poller.READ_ONLY_LOOKUPS = {
    "inverter_state": {
        map: { 0: "Sleep", 1: "Standby", 2: "Charge", 3: "Discharge", 4: "Backup", 5: "OTA", 6: "Bypass" }
    }
};

module.exports = Poller;
