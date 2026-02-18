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

            Logger.info(`Received command for ${key}: ${value}`);
            
            if (MqttClient.LOOKUP_TABLES[key]) {
                const mapping = MqttClient.LOOKUP_TABLES[key];

                if (mapping.register === undefined) {
                    Logger.warn(`${key} is read-only`);
                    return;
                }
                
                const intVal = Object.keys(mapping.map).find(k => mapping.map[k] === value);

                if (intVal !== undefined) {
                    this.writeToDevice(mapping.register, parseInt(intVal));
                    return;
                } else {
                    Logger.warn(`Invalid option string '${value}' for ${key}. Expected: ${Object.values(mapping.map).join(", ")}`);
                    return;
                }
            }
            
            if (MqttClient.NUMBER_CONTROLS[key]) {
                const mapping = MqttClient.NUMBER_CONTROLS[key];
                const intVal = parseInt(value, 10);

                if (isNaN(intVal)) {
                    Logger.warn(`Invalid number '${value}' for ${key}`);
                    return;
                }
                this.writeToDevice(mapping.register, intVal);
                return;
            }

            Logger.warn(`Unknown control key: ${key}`);

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

        Object.entries(data).forEach(([key, value]) => {
            let payload = value;
            
            if (MqttClient.LOOKUP_TABLES[key]) {
                const map = MqttClient.LOOKUP_TABLES[key].map;
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
            const payload = {
                "name": name,
                "unique_id": `marstek2mqtt_${identifier}_${key}`,
                "state_topic": `${MqttClient.TOPIC_PREFIX}/${identifier}/${key}`,
                "device": device,
                "enabled_by_default": true
            };

            if (type === "sensor") {
                if(unit) payload["unit_of_measurement"] = unit;
                if(devClass) payload["device_class"] = devClass;
                if(stateClass) payload["state_class"] = stateClass;
                payload["expire_after"] = Math.ceil((parseInt(process.env.POLL_INTERVAL) || 5000) / 1000) * 2 + 5;
            } else {
                payload["command_topic"] = `${MqttClient.TOPIC_PREFIX}/${identifier}/set/${key}`;
                if (options.min !== undefined) payload["min"] = options.min;
                if (options.max !== undefined) payload["max"] = options.max;
                if (options.step) payload["step"] = options.step;
                
                if (type === "select" && MqttClient.LOOKUP_TABLES[key]) {
                    payload["options"] = Object.values(MqttClient.LOOKUP_TABLES[key].map);
                }

                if (unit) payload["unit_of_measurement"] = unit;
            }

            this.client.publish(discoveryTopic, JSON.stringify(payload), { retain: true });
        };
        
        makeConfig("ac_power", "AC Power", "W", "power", "measurement");
        makeConfig("battery_power", "Battery Power", "W", "power", "measurement");
        makeConfig("battery_voltage", "Battery Voltage", "V", "voltage", "measurement");
        makeConfig("battery_current", "Battery Current", "A", "current", "measurement");
        makeConfig("ac_voltage", "AC Voltage", "V", "voltage", "measurement");
        makeConfig("ac_current", "AC Current", "A", "current", "measurement");
        makeConfig("ac_frequency", "AC Frequency", "Hz", "frequency", "measurement");
        makeConfig("soc", "State of Charge", "%", "battery", "measurement");
        
        makeConfig("total_charging_energy", "Total Charge", "kWh", "energy", "total_increasing");
        makeConfig("total_discharging_energy", "Total Discharge", "kWh", "energy", "total_increasing");
        makeConfig("internal_temperature", "Internal Temp", "°C", "temperature", "measurement");
        
        makeConfig("inverter_state", "Inverter State", null, null, null, "sensor");
        
        makeConfig("set_charge_power", "Set Charge Power", "W", null, null, "number", {min: 0, max: 2500, step: 50});
        makeConfig("set_discharge_power", "Set Discharge Power", "W", null, null, "number", {min: 0, max: 2500, step: 50});
        makeConfig("charge_to_soc", "Charge to SOC", "%", null, null, "number", {min: 10, max: 100, step: 1});
        
        makeConfig("user_work_mode", "User Work Mode", null, null, null, "select");
        makeConfig("force_mode", "Force Mode", null, null, null, "select");
        makeConfig("backup_function", "Backup Function", null, null, null, "select");

        this.autoconfTimestamp = Date.now();
    }
}

MqttClient.TOPIC_PREFIX = "marstek2mqtt";

MqttClient.LOOKUP_TABLES = { // FIXME: why are the registers here? They don't belong here
    "user_work_mode": {
        register: 43000,
        map: { 0: "Manual", 1: "Anti-Feed", 2: "Trade" }
    },
    "force_mode": {
        register: 42010,
        map: { 0: "Stop", 1: "Charge", 2: "Discharge" }
    },
    "backup_function": {
        register: 41200,
        map: { 0: "Enable", 1: "Disable" }
    },
    "inverter_state": {
        // Read-only map used for publishing
        map: { 0: "Sleep", 1: "Standby", 2: "Charge", 3: "Discharge", 4: "Backup", 5: "OTA", 6: "Bypass" }
    }
};

MqttClient.NUMBER_CONTROLS = {
    "set_charge_power": { register: 42020 },
    "set_discharge_power": { register: 42021 },
    "charge_to_soc": { register: 42011 }
};

module.exports = MqttClient;
