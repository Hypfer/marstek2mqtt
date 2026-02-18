const Logger = require("./Logger");
const Poller = require("./Poller");
const MqttClient = require("./MqttClient");

if (process.env.LOGLEVEL) {
    Logger.setLogLevel(process.env.LOGLEVEL);
}

const poller = new Poller();
const mqttClient = new MqttClient(poller);

poller.initialize().then(() => {
    mqttClient.initialize();
}).catch(err => {
    Logger.error("Error while initializing poller", err);
    process.exit(1);
});