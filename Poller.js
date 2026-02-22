const EventEmitter = require("events").EventEmitter;
const ModbusRTU = require("modbus-serial");
const Logger = require("./Logger");

class Poller {
    constructor() {
        this.eventEmitter = new EventEmitter();
        this.client = new ModbusRTU();
        this.connected = false;
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
        
        data.battery_design_capacity = (await this.readBlock(32105, 1)).readUInt16BE(0) * 0.001;

        const ac = await this.readBlock(32200, 5);
        data.ac_voltage   = ac.readUInt16BE(0) * 0.1;
        data.ac_frequency = ac.readInt16BE(8) * 0.1;

        const soc = await this.readBlock(37004, 5);
        data.ac_current = soc.readInt16BE(0) * 0.004; // TODO why 0.004??
        data.soc        = soc.readUInt16BE(2);
        data.max_cell_voltage   = soc.readUInt16BE(6) * 0.001; // TODO assumption
        data.min_cell_voltage   = soc.readUInt16BE(8) * 0.001; // TODO assumption

        const nrg = await this.readBlock(33000, 4);
        data.total_energy_in    = nrg.readUInt32BE(0) * 0.01;
        data.total_energy_out = nrg.readInt32BE(4) * 0.01;

        const temp = await this.readBlock(35000, 3);
        data.internal_temperature = temp.readInt16BE(0) * 0.1;
        data.internal_mos1_temperature = temp.readInt16BE(2) * 0.1;
        data.internal_mos2_temperature = temp.readInt16BE(4) * 0.1;

        const temp2 = await this.readBlock(35010, 2);
        data.max_cell_temperature = temp2.readInt16BE(0) * 0.1;
        data.min_cell_temperature = temp2.readInt16BE(0) * 0.1;

        data.inverter_state = (await this.readBlock(35100, 1)).readUInt16BE(0);
        data.backup_function = (await this.readBlock(41200, 1)).readUInt16BE(0);
        
        const ctrl1 = await this.readBlock(42010, 2);
        data.force_mode    = ctrl1.readUInt16BE(0);
        data.charge_to_soc = ctrl1.readUInt16BE(2);

        const ctrl2 = await this.readBlock(42020, 2);
        data.set_charge_power    = ctrl2.readUInt16BE(0);
        data.set_discharge_power = ctrl2.readUInt16BE(2);

        data.user_work_mode = (await this.readBlock(43000, 1)).readUInt16BE(0);

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
    "user_work_mode": {
        register: 43000,
        type: "select",
        map: { 0: "Manual", 1: "Anti-Feed", 2: "Trade" }
    },
    "force_mode": {
        register: 42010,
        type: "select",
        map: { 0: "Stop", 1: "Charge", 2: "Discharge" }
    },
    "backup_function": {
        register: 41200,
        type: "select",
        map: { 0: "Enable", 1: "Disable" }
    },
    "set_charge_power": { register: 42020, type: "number" },
    "set_discharge_power": { register: 42021, type: "number" },
    "charge_to_soc": { register: 42011, type: "number" }
};

Poller.READ_ONLY_LOOKUPS = {
    "inverter_state": {
        map: { 0: "Sleep", 1: "Standby", 2: "Charge", 3: "Discharge", 4: "Backup", 5: "OTA", 6: "Bypass" }
    }
};

module.exports = Poller;
