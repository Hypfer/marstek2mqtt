const Poller = require("./Poller");

if (!process.env.POLL_IP) {
    console.error("Error: POLL_IP environment variable is not set.");
    console.log("Usage: POLL_IP=192.168.1.50 node test-poller.js");
    process.exit(1);
}

const poller = new Poller();

console.log(`Starting Single Poll Test for IP: ${process.env.POLL_IP}...`);


poller.onData((data) => {
    console.log("Data Received:");
    console.dir(data, { depth: null, colors: true });
    
    if (poller.client && poller.client.isOpen) {
        poller.client.close();
    }
    
    process.exit(0);
});

poller.initialize();

setTimeout(() => {
    console.error("Timeout: No data received within 10 seconds.");
    process.exit(1);
}, 10000);