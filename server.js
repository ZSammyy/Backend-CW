require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 3000;
const dbName = "CWhubbase";

if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI is missing from the environment.");
    process.exit(1);
}

const client = new MongoClient(process.env.MONGODB_URI);
let db;

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
    console.log(`${req.method} ${req.url}`);
    next();
});

app.get("/", (req, res) => {
    res.send("CWhub server is running.");
});

// Get all lessons, with optional search
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

// Save an order
app.post("/orders", async (req, res) => {
    try {
        const name = String(req.body.name || "").trim();
        const phone = String(req.body.phone || "").trim();
        const paymentMethod = String(req.body.paymentMethod || "").trim();
        const lessonIDs = req.body.lessonIDs;
        const allowedPaymentMethods = ["card-demo", "google-pay-demo"];

        if (!name || !phone || !Array.isArray(lessonIDs) || lessonIDs.length === 0) {
            return res.status(400).json({
                error: "Name, phone, and at least one lesson are required."
            });
        }

        if (!lessonIDs.every(id => ObjectId.isValid(id))) {
            return res.status(400).json({
                error: "One or more lesson IDs are invalid."
            });
        }

        if (!allowedPaymentMethods.includes(paymentMethod)) {
            return res.status(400).json({
                error: "Choose a payment method."
            });
        }

        const result = await db.collection("order").insertOne({
            name,
            phone,
            paymentMethod,
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

// Find orders by checkout phone number
app.get("/orders", async (req, res) => {
    const phone = String(req.query.phone || "").trim();

    if (!phone) {
        return res.status(400).json({
            error: "Enter the checkout phone number."
        });
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
            paymentMethod: order.paymentMethod,
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

// Reschedule a lesson in an order
app.put("/orders/:id/reschedule", async (req, res) => {
    const { id } = req.params;
    const phone = String(req.body.phone || "").trim();
    const oldLessonId = String(req.body.oldLessonId || "");
    const newLessonId = String(req.body.newLessonId || "");

    if (
        !ObjectId.isValid(id) ||
        !ObjectId.isValid(oldLessonId) ||
        !ObjectId.isValid(newLessonId)
    ) {
        return res.status(400).json({
            error: "Invalid order or lesson ID."
        });
    }

    if (!phone) {
        return res.status(400).json({ error: "Phone number is required." });
    }

    if (oldLessonId === newLessonId) {
        return res.status(400).json({ error: "Choose a different lesson." });
    }

    try {
        const orderCollection = db.collection("order");
        const lessonCollection = db.collection("Lessons");

        const order = await orderCollection.findOne({
            _id: new ObjectId(id),
            phone
        });

        if (!order) {
            return res.status(404).json({ error: "Order not found." });
        }

        const lessonIDs = order.lessonIDs || [];
        const lessonIndex = lessonIDs.findIndex(
            lessonId => String(lessonId) === oldLessonId
        );

        if (lessonIndex === -1) {
            return res.status(404).json({
                error: "Lesson is not in this order."
            });
        }

        const spaceResult = await lessonCollection.updateOne(
            {
                _id: new ObjectId(newLessonId),
                space: { $gt: 0 }
            },
            { $inc: { space: -1 } }
        );

        if (spaceResult.matchedCount === 0) {
            return res.status(409).json({
                error: "The new lesson was not found or has no spaces left."
            });
        }

        const updatedLessonIDs = [...lessonIDs];
        updatedLessonIDs[lessonIndex] = newLessonId;

        const orderResult = await orderCollection.updateOne(
            {
                _id: order._id,
                phone,
                lessonIDs
            },
            {
                $set: {
                    lessonIDs: updatedLessonIDs,
                    updatedAt: new Date()
                }
            }
        );

        if (orderResult.matchedCount === 0) {
            await lessonCollection.updateOne(
                { _id: new ObjectId(newLessonId) },
                { $inc: { space: 1 } }
            );

            return res.status(409).json({
                error: "The order changed. Please try again."
            });
        }

        await lessonCollection.updateOne(
            { _id: new ObjectId(oldLessonId) },
            { $inc: { space: 1 } }
        );

        res.json({ message: "Order rescheduled successfully." });
    } catch (error) {
        console.error("Could not reschedule order:", error);
        res.status(500).json({
            error: "Could not reschedule the order."
        });
    }
});

// Cancel an order and restore its lesson spaces
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

        res.json({
            message: "Order cancelled and lesson spaces restored."
        });
    } catch (error) {
        console.error("Could not cancel order:", error);
        res.status(500).json({ error: "Could not cancel the order." });
    }
});

// Update lesson spaces
app.put("/lessons/:id", async (req, res) => {
    const { id } = req.params;
    const space = Number(req.body.space);

    if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid lesson ID." });
    }

    if (!Number.isInteger(space) || space < 0) {
        return res.status(400).json({
            error: "Space must be a non-negative whole number."
        });
    }

    try {
        const result = await db.collection("Lessons").updateOne(
            { _id: new ObjectId(id) },
            { $set: { space } }
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

// Get the number of purchased lesson slots
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
                (order.lessonIDs || []).filter(id => id === lessonId).length;
        }, 0);

        res.json({ lessonId, enrolment });
    } catch (error) {
        console.error("Could not get enrolment:", error);
        res.status(500).json({ error: "Could not get enrolment." });
    }
});

// Get notifications for a phone number
app.get("/notifications", async (req, res) => {
    const phone = String(req.query.phone || "").trim();

    if (!phone) {
        return res.status(400).json({ error: "Phone number is required." });
    }

    try {
        const notifications = await db.collection("notifications")
            .find({ phone })
            .sort({ createdAt: -1 })
            .toArray();

        res.json(notifications);
    } catch (error) {
        console.error("Could not get notifications:", error);
        res.status(500).json({ error: "Could not get notifications." });
    }
});

// Save a notification
app.post("/notifications", async (req, res) => {
    const phone = String(req.body.phone || "").trim();
    const message = String(req.body.message || "").trim();

    if (!phone || !message) {
        return res.status(400).json({
            error: "Phone number and message are required."
        });
    }

    try {
        const notification = {
            phone,
            message,
            read: false,
            createdAt: new Date()
        };

        const result = await db.collection("notifications")
            .insertOne(notification);

        res.status(201).json({
            ...notification,
            _id: result.insertedId
        });
    } catch (error) {
        console.error("Could not save notification:", error);
        res.status(500).json({
            error: "Could not save the notification."
        });
    }
});

// Mark all notifications as read
app.patch("/notifications/read-all", async (req, res) => {
    const phone = String(req.body.phone || "").trim();

    if (!phone) {
        return res.status(400).json({ error: "Phone number is required." });
    }

    try {
        await db.collection("notifications").updateMany(
            { phone, read: false },
            { $set: { read: true } }
        );

        res.json({ message: "All notifications marked as read." });
    } catch (error) {
        console.error("Could not mark all notifications as read:", error);
        res.status(500).json({ error: "Could not update notifications." });
    }
});

// Mark one notification as read
app.patch("/notifications/:id/read", async (req, res) => {
    const phone = String(req.body.phone || "").trim();
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid notification ID." });
    }

    if (!phone) {
        return res.status(400).json({ error: "Phone number is required." });
    }

    try {
        const result = await db.collection("notifications").updateOne(
            { _id: new ObjectId(id), phone },
            { $set: { read: true } }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ error: "Notification not found." });
        }

        res.json({ message: "Notification marked as read." });
    } catch (error) {
        console.error("Could not mark notification as read:", error);
        res.status(500).json({ error: "Could not update the notification." });
    }
});

// Delete one notification
app.delete("/notifications/:id", async (req, res) => {
    const phone = String(req.body.phone || "").trim();
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid notification ID." });
    }

    if (!phone) {
        return res.status(400).json({ error: "Phone number is required." });
    }

    try {
        const result = await db.collection("notifications").deleteOne({
            _id: new ObjectId(id),
            phone
        });

        if (result.deletedCount === 0) {
            return res.status(404).json({ error: "Notification not found." });
        }

        res.json({ message: "Notification deleted." });
    } catch (error) {
        console.error("Could not delete notification:", error);
        res.status(500).json({
            error: "Could not delete the notification."
        });
    }
});

// Clear all notifications for a phone number
app.delete("/notifications", async (req, res) => {
    const phone = String(req.body.phone || "").trim();

    if (!phone) {
        return res.status(400).json({ error: "Phone number is required." });
    }

    try {
        await db.collection("notifications").deleteMany({ phone });
        res.json({ message: "Notifications cleared." });
    } catch (error) {
        console.error("Could not clear notifications:", error);
        res.status(500).json({
            error: "Could not clear notifications."
        });
    }
});

async function startServer() {
    try {
        await client.connect();
        db = client.db(dbName);

        console.log("Connected to MongoDB Atlas");

        app.listen(port, () => {
            console.log(`Server running on port ${port}`);
        });
    } catch (error) {
        console.error("MongoDB connection failed:", error.message);
        process.exit(1);
    }
}

startServer();