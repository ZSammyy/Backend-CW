require("dotenv").config();

const { MongoClient } = require("mongodb");
const express = require("express");
const cors = require("cors");

const app = express();
const port = 3000;
const client = new MongoClient(process.env.MONGODB_URI);
const dbName = "CWhubbase";
let db;

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
    console.log(`${req.method} ${req.url}`);
    next();
});
app.get("/lessons", async (req, res) => {
    try {
        const lessons = await db.collection("Lessons").find({}).toArray();
        res.json(lessons);
    } catch (error) {
        console.error("Could not get lessons:", error);
        res.status(500).json({ error: "Could not get lessons." });
    }
});

app.get("/", (req, res) => {
    res.send("CWhub server is running.");
});

async function startServer() {
    try {
        await client.connect();
        console.log("Connected to MongoDB Atlas");

        db = client.db(dbName);


        app.get("/lessons", async (req, res) => {
            try {
                const lessons = await db.collection("Lessons").find({}).toArray();
                res.json(lessons);
            } catch (error) {
                console.error("Could not get lessons:", error);
                res.status(500).json({ error: "Could not get lessons." });
            }
        });

        app.post("/orders", async (req, res) => {
            try {
                const { name, phone, lessonIDs } = req.body;

                if (!name || !phone || !Array.isArray(lessonIDs) || lessonIDs.length === 0) {
                    return res.status(400).json({
                        error: "Name, phone, and at least one lesson are required."
                    });
                }

                const result = await db.collection("order").insertOne({
                    name,
                    phone,
                    lessonIDs,
                    spaces: lessonIDs.length,
                    createdAt: new Date()
                });

                res.status(201).json({
                    message: "Order saved.",
                    orderId: result.insertedId
                });
            } catch (error) {
                console.error("Could not save order:", error);
                res.status(500).json({ error: "Could not save the order." });
            }
        });



        app.listen(port, () => {
            console.log(`Server running at http://localhost:${port}`);
        });
    } catch (error) {
        console.error("MongoDB connection failed:", error.message);
    }
}

startServer();