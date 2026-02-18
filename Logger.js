const util = require("util");

class Logger {
    constructor() {
        this.logLevel = Logger.LogLevels["info"];
    }

    getLogLevel() {
        return Object.keys(Logger.LogLevels).find(key => {
            return Logger.LogLevels[key] === this.logLevel;
        });
    }

    setLogLevel(value) {
        if (Logger.LogLevels[value] === undefined) {
            throw new Error(`Invalid log level '${value}', valid are '${Object.keys(Logger.LogLevels).join("','")}'`);
        } else {
            this.logLevel = Logger.LogLevels[value];
        }
    }

    buildLogLinePrefix(logLevel) {
        return `[${new Date().toISOString()}] [${logLevel}]`;
    }

    log(level, ...args) {
        if (this.logLevel["level"] <= Logger.LogLevels[level]["level"]) {
            const logLinePrefix = this.buildLogLinePrefix(level.toUpperCase());
            const logLine = [logLinePrefix, ...args].map(arg => {
                if (typeof arg === "string") {
                    return arg;
                }
                return util.inspect(arg, { depth: Infinity });
            }).join(" ");

            Logger.LogLevels[level]["callback"](logLine);
        }
    }

    trace(...args) { this.log("trace", ...args); }
    debug(...args) { this.log("debug", ...args); }
    info(...args) { this.log("info", ...args); }
    warn(...args) { this.log("warn", ...args); }
    error(...args) { this.log("error", ...args); }
}

Logger.LogLevels = Object.freeze({
    "trace": {"level": -2, "callback": console.debug},
    "debug": {"level": -1, "callback": console.debug},
    "info": {"level": 0, "callback": console.info},
    "warn": {"level": 1, "callback": console.warn},
    "error": {"level": 2, "callback": console.error},
});

module.exports = new Logger();
