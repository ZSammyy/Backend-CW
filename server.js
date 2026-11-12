require("dotenv").config();
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");
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
app.use(
    "/images",
    express.static(path.join(__dirname, "../Frontend-CW/images"))
);


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
                const searchText = String(req.query.search || "").trim().toLowerCase();
                const allLessons = await db.collection("Lessons").find({}).toArray();

                const lessons = searchText
                    ? allLessons.filter(lesson =>
                        [lesson.topic, lesson.location, lesson.price, lesson.space]
                            .some(value => String(value).toLowerCase().includes(searchText))
                    )
                    : allLessons;

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
        app.get("/orders", async (req, res) => {
            const phone = String(req.query.phone || "").trim();

            if (!phone) {
                return res.status(400).json({ error: "Enter the checkout phone number." });
            }

            try {
                const orders = await db.collection("order")
                    .find({ phone })
                    .sort({ createdAt: -1 })
                    .toArray();

                const lessonIds = [
                    ...new Set(orders.flatMap(order => order.lessonIDs || []))
                ]
                    .filter(id => ObjectId.isValid(id))
                    .map(id => new ObjectId(id));

                const lessons = lessonIds.length > 0
                    ? await db.collection("Lessons")
                        .find({ _id: { $in: lessonIds } })
                        .toArray()
                    : [];

                const lessonsById = new Map(
                    lessons.map(lesson => [String(lesson._id), lesson])
                );

                const ordersWithLessons = orders.map(order => ({
                    _id: order._id,
                    createdAt: order.createdAt,
                    lessons: (order.lessonIDs || [])
                        .map(id => lessonsById.get(String(id)))
                        .filter(Boolean)
                }));

                res.json(ordersWithLessons);
            } catch (error) {
                console.error("Could not get orders:", error);
                res.status(500).json({ error: "Could not get orders." });
            }
        });
        app.delete("/orders/:id", async (req, res) => {
            const { id } = req.params;
            const phone = String(req.body.phone || "").trim();

            if (!ObjectId.isValid(id)) {
                return res.status(400).json({ error: "Invalid order ID." });
            }

            if (!phone) {
                return res.status(400).json({ error: "Phone number is required." });
            }

            try {
                const order = await db.collection("order").findOne({
                    _id: new ObjectId(id),
                    phone
                });

                if (!order) {
                    return res.status(404).json({ error: "Order not found." });
                }

                await db.collection("order").deleteOne({ _id: order._id });

                for (const lessonId of order.lessonIDs || []) {
                    if (ObjectId.isValid(lessonId)) {
                        await db.collection("Lessons").updateOne(
                            { _id: new ObjectId(lessonId) },
                            { $inc: { space: 1 } }
                        );
                    }
                }

                res.json({ message: "Order cancelled and lesson spaces restored." });
            } catch (error) {
                console.error("Could not cancel order:", error);
                res.status(500).json({ error: "Could not cancel the order." });
            }
        });

        app.put("/lessons/:id", async (req, res) => {
            try {
                const { id } = req.params;

                if (!ObjectId.isValid(id)) {
                    return res.status(400).json({ error: "Invalid lesson ID." });
                }

                const updates = { ...req.body };
                delete updates._id;

                if (Object.keys(updates).length === 0) {
                    return res.status(400).json({ error: "No lesson fields were provided." });
                }

                const result = await db.collection("Lessons").updateOne(
                    { _id: new ObjectId(id) },
                    { $set: updates }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).json({ error: "Lesson not found." });
                }

                res.json({ message: "Lesson updated." });
            } catch (error) {
                console.error("Could not update lesson:", error);
                res.status(500).json({ error: "Could not update the lesson." });
            }
        });

        app.get("/enrolment/:lessonid", async (req, res) => {
            const lessonId = req.params.lessonid;

            if (!ObjectId.isValid(lessonId)) {
                return res.status(400).json({ error: "Invalid lesson ID." });
            }

            try {
                const orders = await db.collection("order")
                    .find({ lessonIDs: lessonId })
                    .toArray();

                const enrolment = orders.reduce((total, order) => {
                    return total +
                        order.lessonIDs.filter(id => id === lessonId).length;
                }, 0);

                res.json({ lessonId, enrolment });
            } catch (error) {
                console.error("Could not get enrolment:", error);
                res.status(500).json({ error: "Could not get enrolment." });
            }
        });



        app.listen(port, () => {
            console.log(`Server running at http://localhost:${port}`);
        });
    } catch (error) {
        console.error("MongoDB connection failed:", error.message);
    }
}
