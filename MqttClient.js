const Logger = require("./Logger");
const mqtt = require("mqtt");

class MqttClient {
    /**
     * @param {import("./Poller")} poller
     */
    constructor(poller) {
        this.poller = poller;
        this.identifier = process.env.IDENTIFIER || "One";
        this.autoconfTimestamp = 0;

        this.poller.onData((data) => {
            this.handleData(data);
        });
    }

    initialize() {
        const options = {
            clientId: `marstek2mqtt_${this.identifier}_${Math.random().toString(16).slice(2, 9)}`,
        };

        if (process.env.MQTT_USERNAME) {
            options.username = process.env.MQTT_USERNAME;
            options.password = process.env.MQTT_PASSWORD;
        }

        this.client = mqtt.connect(process.env.MQTT_BROKER_URL, options);

        this.client.on("connect", () => {
            Logger.info("Connected to MQTT broker");
            const commandTopic = `${MqttClient.TOPIC_PREFIX}/${this.identifier}/set/#`;
            this.client.subscribe(commandTopic, (err) => {
                if(err) Logger.error("Failed to subscribe to commands", err);
                else Logger.info(`Subscribed to commands: ${commandTopic}`);
            });
        });

        this.client.on("error", (e) => {
            Logger.error("MQTT error:", e.toString());
        });

        this.client.on("message", (topic, message) => {
            this.handleCommand(topic, message);
        });
    }

    handleCommand(topic, message) {
        try {
            const parts = topic.split("/");
            // Topic format: marstek2mqtt/<ID>/set/<key>
            if (parts.length !== 4 || parts[2] !== "set") return;

            const key = parts[3];
            let value = message.toString();
            const controls = this.poller.constructor.CONTROLS;

            Logger.info(`Received command for ${key}: ${value}`);

            if (!controls[key]) {
                Logger.warn(`Unknown control key: ${key}`);
                return;
            }

            const control = controls[key];

            if (control.type === "select") {
                const intVal = Object.keys(control.map).find(k => control.map[k] === value);

                if (intVal !== undefined) {
                    this.writeToDevice(control.register, parseInt(intVal));
                } else {
                    Logger.warn(`Invalid option '${value}' for ${key}. Expected: ${Object.values(control.map).join(", ")}`);
                }
                return;
            }

            if (control.type === "switch") {
                if (value === "ON") {
                    this.writeToDevice(control.register, control.on);
                } else if (value === "OFF") {
                    this.writeToDevice(control.register, control.off);
                } else {
                    Logger.warn(`Invalid value '${value}' for switch ${key}. Expected: ON, OFF`);
                }
                return;
            }

            if (control.type === "button") {
                if (value === "PRESS") {
                    this.writeToDevice(control.register, control.command);
                } else {
                    Logger.warn(`Invalid value '${value}' for button ${key}. Expected: PRESS`);
                }
                return;
            }

            if (control.type === "number") {
                const intVal = parseInt(value, 10);
                if (isNaN(intVal)) {
                    Logger.warn(`Invalid number '${value}' for ${key}`);
                    return;
                }

                this.writeToDevice(control.register, intVal);
            }

        } catch (e) {
            Logger.error("Error processing command", e);
        }
    }

    writeToDevice(register, value) {
        this.poller.writeRegister(register, value)
            .then(() => Logger.info(`Successfully wrote ${value} to register ${register}`))
            .catch(err => Logger.error(`Failed to write to register ${register}`, err));
    }

    handleData(data) {
        this.ensureAutoconf(this.identifier);
        const baseTopic = `${MqttClient.TOPIC_PREFIX}/${this.identifier}`;
        const controls = this.poller.constructor.CONTROLS;
        const readOnly = this.poller.constructor.READ_ONLY_LOOKUPS;

        Object.entries(data).forEach(([key, value]) => {
            let payload = value;

            if (controls[key]) {
                if (controls[key].type === "button") return;

                if (controls[key].type === "select") {
                    const map = controls[key].map;
                    if (map[value] !== undefined) {
                        payload = map[value];
                    } else {
                        Logger.warn(`Value ${value} for ${key} not found in control map`);
                    }
                } else if (controls[key].type === "switch") {
                    if (value === controls[key].on) payload = "ON";
                    else if (value === controls[key].off) payload = "OFF";
                    else payload = "UNKNOWN";
                }
            } else if (readOnly[key]) {
                const map = readOnly[key].map;
                if (map[value] !== undefined) {
                    payload = map[value];
                } else {
                    Logger.warn(`Value ${value} for ${key} not found in lookup map`);
                }
            }

            this.client.publish(`${baseTopic}/${key}`, `${payload}`);
        });
    }

    ensureAutoconf(identifier) {
        // Republish every 4 hours
        if (Date.now() - this.autoconfTimestamp <= 4 * 60 * 60 * 1000) {
            return;
        }

        const device = {
            "manufacturer": "Marstek",
            "model": "Venus",
            "name": `Marstek Venus ${identifier}`,
            "identifiers": [`marstek2mqtt_${identifier}`]
        };

        const makeConfig = (key, name, unit, devClass, stateClass, type = "sensor", options = {}) => {
            const discoveryTopic = `homeassistant/${type}/marstek2mqtt_${identifier}/${key}/config`;
            const enabledByDefault = options.enabled_by_default !== false;

            const payload = {
                "name": name,
                "unique_id": `marstek2mqtt_${identifier}_${key}`,
                "state_topic": `${MqttClient.TOPIC_PREFIX}/${identifier}/${key}`,
                "device": device,
                "enabled_by_default": enabledByDefault
            };

            if (options.entity_category) {
                payload["entity_category"] = options.entity_category;
            }

            if (type === "sensor") {
                if (unit) payload["unit_of_measurement"] = unit;
                if (devClass) payload["device_class"] = devClass;
                if (stateClass) payload["state_class"] = stateClass;

                if (options.precision !== undefined) {
                    payload["suggested_display_precision"] = options.precision;
                }

                payload["expire_after"] = Math.ceil((parseInt(process.env.POLL_INTERVAL) || 5000) / 1000) * 2 + 5;
            } else {
                payload["command_topic"] = `${MqttClient.TOPIC_PREFIX}/${identifier}/set/${key}`;
                if (options.min !== undefined) payload["min"] = options.min;
                if (options.max !== undefined) payload["max"] = options.max;
                if (options.step) payload["step"] = options.step;

                const controls = this.poller.constructor.CONTROLS;
                if (type === "select" && controls[key] && controls[key].map) {
                    payload["options"] = Object.values(controls[key].map);
                }

                if (type === "button") {
                    delete payload["state_topic"];
                }

                if (unit) payload["unit_of_measurement"] = unit;
            }

            this.client.publish(discoveryTopic, JSON.stringify(payload), { retain: true });
        };

        makeConfig("ac_power", "AC Power", "W", "power", "measurement", "sensor", { precision: 0 });
        makeConfig("battery_power", "Battery Power", "W", "power", "measurement", "sensor", { precision: 0 });
        makeConfig("battery_voltage", "Battery Voltage", "V", "voltage", "measurement", "sensor", { precision: 3 });
        makeConfig("battery_current", "Battery Current", "A", "current", "measurement", "sensor", { precision: 3 });
        makeConfig("ac_voltage", "AC Voltage", "V", "voltage", "measurement", "sensor", { precision: 3 });
        makeConfig("ac_current", "AC Current", "A", "current", "measurement", "sensor", { precision: 3 });
        makeConfig("ac_frequency", "AC Frequency", "Hz", "frequency", "measurement", "sensor", { precision: 2 });
        makeConfig("soc", "State of Charge", "%", "battery", "measurement", "sensor", { precision: 2 });
        makeConfig("battery_design_capacity", "Design Capacity", "kWh", null,"measurement", "sensor", { precision: 3, enabled_by_default: false });
        makeConfig("remaining_energy", "Remaining Energy", "kWh", "energy_storage", "measurement", "sensor", { precision: 2 });

        makeConfig("total_energy_in", "Total Energy In", "kWh", "energy", "total_increasing", "sensor", { precision: 3 });
        makeConfig("total_energy_out", "Total Energy Out", "kWh", "energy", "total_increasing", "sensor", { precision: 3 });

        makeConfig("internal_temperature", "Internal Temp", "°C", "temperature", "measurement", "sensor", { precision: 1 });
        makeConfig("internal_mos1_temperature", "Internal MOS1 Temp", "°C", "temperature", "measurement", "sensor", { precision: 1 });
        makeConfig("internal_mos2_temperature", "Internal MOS2 Temp", "°C", "temperature", "measurement", "sensor", { precision: 1 });
        makeConfig("max_cell_temperature", "Max Cell Temp", "°C", "temperature", "measurement", "sensor", { precision: 1 });
        makeConfig("min_cell_temperature", "Min Cell Temp", "°C", "temperature", "measurement", "sensor", { precision: 1 });

        makeConfig("max_cell_voltage", "Max Cell Voltage", "V", "voltage", "measurement", "sensor", { precision: 3, entity_category: "diagnostic" });
        makeConfig("min_cell_voltage", "Min Cell Voltage", "V", "voltage", "measurement", "sensor", { precision: 3, entity_category: "diagnostic" });

        for (let i = 1; i <= 4; i++) {
            makeConfig(`mppt${i}_voltage`, `MPPT ${i} Voltage`, "V", "voltage", "measurement", "sensor", { precision: 3 });
            makeConfig(`mppt${i}_current`, `MPPT ${i} Current`, "A", "current", "measurement", "sensor", { precision: 3 });
            makeConfig(`mppt${i}_power`, `MPPT ${i} Power`, "W", "power", "measurement", "sensor", { precision: 0 });
        }

        for (let b = 1; b <= 6; b++) {
            makeConfig(`battery_${b}_soc`, `Battery ${b} SOC`, "%", "battery", "measurement", "sensor", { precision: 2 });
            for (let c = 1; c <= 13; c++) {
                makeConfig(`battery_${b}_cell_${c}_voltage`, `Battery ${b} Cell ${c} Voltage`, "V", "voltage", "measurement", "sensor", { precision: 3, enabled_by_default: false, entity_category: "diagnostic" });
            }
        }

        makeConfig("inverter_state", "Inverter State", null, null, null, "sensor");

        makeConfig("set_charge_power", "Set Charge Power", "W", null, null, "number", { min: 0, max: 2500, step: 50, enabled_by_default: false });
        makeConfig("set_discharge_power", "Set Discharge Power", "W", null, null, "number", { min: 0, max: 2500, step: 50, enabled_by_default: false });
        makeConfig("charge_to_soc", "Charge to SOC", "%", null, null, "number", { min: 10, max: 100, step: 1, enabled_by_default: false });

        makeConfig("user_work_mode", "User Work Mode", null, null, null, "select");
        makeConfig("force_mode", "Force Mode", null, null, null, "select", {enabled_by_default: false});

        makeConfig("backup_function", "Backup Function", null, null, null, "switch");
        makeConfig("rs485_control_mode", "RS485 Control Mode", null, null, null, "switch", { enabled_by_default: false });

        makeConfig("reset_device", "Reset Device", null, null, null, "button", { enabled_by_default: false });
        makeConfig("factory_reset", "Factory Reset", null, null, null, "button", { enabled_by_default: false });

        this.autoconfTimestamp = Date.now();
    }
}

MqttClient.TOPIC_PREFIX = "marstek2mqtt";

module.exports = MqttClient;
