var mysql = require('mysql2');
const express = require("express");
const http = require("http");
const path = require("path");


const app = express();
const server = http.createServer(app);
const io = require("socket.io")(server);


const connection = mysql.createConnection({
    host: 'localhost',     // host for connection
    port: 3306,            // default port for mysql is 3306
    database: 'websense',      // database from which we want to connect our node application
    user: 'root',          // username of the mysql connection
    password: ''       // password of the mysql connection
});


app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});


app.get("/api/sensors", (req, res) => {
    connection.connect((err) => {
        if (err) throw err;

        let sqlQuery =`
            SELECT sensor_key, name, type, unit
            FROM sensors`;
        connection.query(sqlQuery, (err, result) => {
            if (err) throw err;
            res.json(result);
        });
    });
});


app.get("/api/readings/latest", (req, res) => {
    const sensor = req.query.sensor;
    const limit = req.query.limit;

    connection.connect((err) => {
        if (err) throw err;

        let sqlQuery = `
            SELECT sensors.sensor_key, readings.sensor_id, readings.value, readings.created_at
            FROM readings 
            INNER JOIN sensors ON readings.sensor_id = sensors.id
            WHERE sensor_key="${sensor}"
            ORDER BY created_at DESC
            LIMIT ${limit}
        `;

        connection.query(sqlQuery, (err, result) => {
            if (err) throw err;
            res.json(result);
        });

    });
});


app.get("/api/readings/range", (req, res) => {
    
    const sensor = req.query.sensor;
    const start = req.query.start;
    const end = req.query.end;

    connection.connect((err) => {
        if (err) throw err;

        let sqlQuery = `
            SELECT sensors.sensor_key, readings.sensor_id, readings.value, readings.created_at
            FROM readings
            INNER JOIN sensors on readings.sensor_id = sensors.id
            WHERE sensor_key="${sensor}" AND created_at >= "${start}" AND created_at <= "${end}"
        `

        connection.query(sqlQuery, (err, result) => {
            if (err) throw err;
            res.json(result);
        })

    })

});


// Config
const contikiMotes = [
    {key: "mote-1", url: "http://[fd00::202:2:2:2]/temp", name: "Living Room", type: "temperature"},
    {key: "mote-2", url: "http://[fd00::203:3:3:3]/temp", name: "Kitchen", type: "temperature"},
    {key: "mote-3", url: "http://[fd00::204:4:4:4]/temp", name: "Master Bedroom", type: "temperature"},
];

const CONTIKI_URL = "http://[fd00::202:2:2:2]/temp";
const PUSH_INTERVAL_MS = 3000;


function stripIPv6Brackets(host) {
    if (!host) return host;
    
    if (host.startsWith("[") && host.endsWith("]")) {
        return host.slice(1, -1);
    }
    
    return host;
}

/**
 * Helper to fetch JSON from a Contiki-NG mote with timeout handling
 */
function fetchContikiJson(urlString) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlString);
        const host = stripIPv6Brackets(u.hostname);

        const options = {
            protocol: u.protocol,
            hostname: host,
            port: u.port ? Number(u.port) : 80,
            path: u.pathname + (u.search || ""),
            method: "GET",
            headers: {
                "Accept": "application/json",
                "Connection": "close"
            },
            timeout: 2500,
            insecureHTTPParser: true
        };

        const req = http.request(options, (res) => {
            let body = "";
            res.setEncoding("utf8");
            
            res.on("data", (chunk) => {
                body += chunk;
            });

            res.on("end", () => {
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject(new Error("Invalid JSON body: " + body));
                }
            });
        });

        req.on("timeout", () => {
            req.destroy(new Error("Timeout"));
        });

        req.on("error", (err) => {
            reject(err);
        });

        req.end();
    });
}

function insertReading(sensor, obj) {
    /**
     * Checks if sensorKey already exists in the sensors table and insert the reading. If it does not
     * it inserts the key it into the sensors table and then inserts the reading.
     */
    connection.connect(function(err) {
        if (err) throw err;
        
        let sqlQuery = `SELECT * FROM sensors WHERE sensor_key="${sensor.key}"`;
        connection.query(sqlQuery, function (err, result) {
            if (err) throw err
            else {
                // If the results array is empty insert the sensor key into the sensors table.
                if (result.length === 0) {
                    let insertQuery = `INSERT INTO sensors (sensor_key, name, type, unit) 
                                       VALUES ("${sensor.key}", "${sensor.name}", "${sensor.type}", "${obj.unit}")`;
                    connection.query(insertQuery, function (err, result) {
                        if (err) throw err;
                        else {
                            connection.query(sqlQuery, function (err, result) {
                                if (err) throw err;
                                else {
                                    connection.query(`INSERT INTO readings (sensor_id, value, created_at) VALUES ("${result[0].id}", "${obj.temperature}", "${new Date().toISOString().slice(0, -5).replace('T', ' ')}")`);
                                }
                            });
                        }
                    });
                } else {
                    connection.query(`INSERT INTO readings (sensor_id, value, created_at) VALUES ("${result[0].id}", "${obj.temperature}", "${new Date().toISOString().slice(0, -5).replace('T', ' ')}")`);
                }
            }
        });
    });
}


    
io.on("connection", (socket) => {
    console.log("client connected:", socket.id);

    // Set up the polling interval for the connected client
    const timer = setInterval(async () => {
        for (mote of contikiMotes) {
            try {
                const obj = await fetchContikiJson(mote.url);


                // Attempt to find the temperature field regardless of the sensor's key naming
                const temp = obj.temp ?? obj.temperature ?? obj.t ?? obj.value;
                
                if (temp === undefined) {
                    console.log("No temperature field in JSON:", obj);
                    return;
                }

                insertReading(mote, obj);

                // console.log(getSensorID(sensorKey));

                // Emit data to the frontend for real-time visualization
                io.emit("data", temp);
            } catch (error) {
                console.log("request error:", error.message || error);
            }
        }

    }, PUSH_INTERVAL_MS);

    socket.on("disconnect", () => {
        console.log("client disconnected:", socket.id);
        // Clean up the interval to prevent memory leaks.
        clearInterval(timer); 
    });
});
    

/**
 * Server Initialization
 */
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`listening on http://localhost:${PORT}`);
    console.log(`polling Contiki at: ${CONTIKI_URL}`);
});