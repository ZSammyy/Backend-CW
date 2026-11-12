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
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
});

app.get("/", (req, res) => {
    res.send("CWhub server is running.");
});

// Give older lesson documents a default option until they are updated in Compass.
function getScheduleOptions(lesson) {
    if (Array.isArray(lesson.scheduleOptions) && lesson.scheduleOptions.length > 0) {
        return lesson.scheduleOptions.map((option, index) => ({
            ...option,
            id: String(option.id || `option-${index + 1}`),
            label: option.label || `Option ${index + 1}`,
            space: Number(option.space) || 0,
            sessions: Array.isArray(option.sessions) ? option.sessions : []
        }));
    }

    return [
        {
            id: "default",
            label: "Current timetable",
            space: Number(lesson.space) || 0,
            sessions: Array.isArray(lesson.sessions) ? lesson.sessions : []
        }
    ];
}

function getSelectionsFromOrder(order) {
    if (Array.isArray(order.lessonSelections)) {
        return order.lessonSelections.map(selection => ({
            lessonId: String(selection.lessonId),
            optionId: String(selection.optionId || "default")
        }));
    }

    return (order.lessonIDs || []).map(lessonId => ({
        lessonId: String(lessonId),
        optionId: "default"
    }));
}

async function reserveScheduleOption(lessonId, optionId) {
    const lessonObjectId = new ObjectId(lessonId);
    const lesson = await db.collection("Lessons").findOne({ _id: lessonObjectId });

    if (!lesson) {
        return { ok: false, message: "A selected lesson could not be found." };
    }

    if (Array.isArray(lesson.scheduleOptions) && lesson.scheduleOptions.length > 0) {
        const result = await db.collection("Lessons").updateOne(
            {
                _id: lessonObjectId,
                scheduleOptions: {
                    $elemMatch: {
                        id: optionId,
                        space: { $gt: 0 }
                    }
                }
            },
            {
                $inc: { "scheduleOptions.$.space": -1 }
            }
        );

        if (result.matchedCount === 0) {
            return {
                ok: false,
                message: "That timetable option has no spaces left."
            };
        }

        return { ok: true };
    }

    if (optionId !== "default") {
        return { ok: false, message: "The selected timetable option was not found." };
    }

    const result = await db.collection("Lessons").updateOne(
        {
            _id: lessonObjectId,
            space: { $gt: 0 }
        },
        {
            $inc: { space: -1 }
        }
    );

    if (result.matchedCount === 0) {
        return { ok: false, message: "That lesson has no spaces left." };
    }

    return { ok: true };
}

async function restoreScheduleOption(lessonId, optionId) {
    if (!ObjectId.isValid(lessonId)) return;

    const lessonObjectId = new ObjectId(lessonId);
    const lesson = await db.collection("Lessons").findOne({ _id: lessonObjectId });

    if (!lesson) return;

    if (Array.isArray(lesson.scheduleOptions) && lesson.scheduleOptions.length > 0) {
        await db.collection("Lessons").updateOne(
            {
                _id: lessonObjectId,
                "scheduleOptions.id": optionId
            },
            {
                $inc: { "scheduleOptions.$.space": 1 }
            }
        );

        return;
    }

    await db.collection("Lessons").updateOne(
        { _id: lessonObjectId },
        { $inc: { space: 1 } }
    );
}

// Get lessons. Search can match lesson details and timetable options.
app.get("/lessons", async (req, res) => {
    try {
        const searchText = String(req.query.search || "").trim().toLowerCase();
        const allLessons = await db.collection("Lessons").find({}).toArray();

        const lessons = allLessons
            .map(lesson => ({
                ...lesson,
                scheduleOptions: getScheduleOptions(lesson)
            }))
            .filter(lesson => {
                if (!searchText) return true;

                const searchableValues = [
                    lesson.topic,
                    lesson.location,
                    lesson.price,
                    ...lesson.scheduleOptions.flatMap(option => [
                        option.label,
                        option.space,
                        ...option.sessions.flatMap(session => [
                            session.day,
                            session.startTime,
                            session.endTime
                        ])
                    ])
                ];

                return searchableValues.some(value =>
                    String(value ?? "").toLowerCase().includes(searchText)
                );
            });

        res.json(lessons);
    } catch (error) {
        console.error("Could not get lessons:", error);
        res.status(500).json({ error: "Could not get lessons." });
    }
});

// Save an order and reserve one space in each selected timetable option.
app.post("/orders", async (req, res) => {
    const reservedSelections = [];

    try {
        const name = String(req.body.name || "").trim();
        const phone = String(req.body.phone || "").trim();
        const paymentMethod = String(req.body.paymentMethod || "").trim();
        const allowedPaymentMethods = ["card-demo", "google-pay-demo"];

        const usesScheduleOptions = Array.isArray(req.body.lessonSelections);

        let lessonSelections;

        if (usesScheduleOptions) {
            lessonSelections = req.body.lessonSelections.map(selection => ({
                lessonId: String(selection.lessonId || ""),
                optionId: String(selection.optionId || "")
            }));
        } else if (Array.isArray(req.body.lessonIDs)) {
            // Supports the older frontend while it is being updated.
            lessonSelections = req.body.lessonIDs.map(lessonId => ({
                lessonId: String(lessonId),
                optionId: "default"
            }));
        } else {
            lessonSelections = [];
        }

        if (!name || !phone || lessonSelections.length === 0) {
            return res.status(400).json({
                error: "Name, phone, and at least one lesson are required."
            });
        }

        if (!lessonSelections.every(selection =>
            ObjectId.isValid(selection.lessonId) && selection.optionId
        )) {
            return res.status(400).json({
                error: "One or more lesson or timetable option IDs are invalid."
            });
        }

        if (!allowedPaymentMethods.includes(paymentMethod)) {
            return res.status(400).json({
                error: "Choose a payment method."
            });
        }

        // New frontend requests reserve option spaces here.
        // Older requests continue using the existing PUT /lessons/:id route.
        if (usesScheduleOptions) {
            for (const selection of lessonSelections) {
                const reservation = await reserveScheduleOption(
                    selection.lessonId,
                    selection.optionId
                );

                if (!reservation.ok) {
                    for (const reserved of reservedSelections) {
                        await restoreScheduleOption(
                            reserved.lessonId,
                            reserved.optionId
                        );
                    }

                    return res.status(409).json({
                        error: reservation.message
                    });
                }

                reservedSelections.push(selection);
            }
        }

        const lessonIDs = lessonSelections.map(selection => selection.lessonId);

        const order = {
            name,
            phone,
            paymentMethod,
            lessonSelections,
            lessonIDs,
            spaces: lessonSelections.length,
            createdAt: new Date()
        };

        const result = await db.collection("order").insertOne(order);

        res.status(201).json({
            message: "Order saved.",
            orderId: result.insertedId
        });
    } catch (error) {
        for (const reserved of reservedSelections) {
            try {
                await restoreScheduleOption(reserved.lessonId, reserved.optionId);
            } catch (restoreError) {
                console.error("Could not restore a reserved space:", restoreError);
            }
        }

        console.error("Could not save order:", error);
        res.status(500).json({ error: "Could not save the order." });
    }
});

// Find orders by checkout phone number.
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

        const allSelections = orders.flatMap(order => getSelectionsFromOrder(order));
        const lessonObjectIds = [
            ...new Set(allSelections.map(selection => selection.lessonId))
        ]
            .filter(ObjectId.isValid)
            .map(id => new ObjectId(id));

        const lessonDocuments = lessonObjectIds.length > 0
            ? await db.collection("Lessons")
                .find({ _id: { $in: lessonObjectIds } })
                .toArray()
            : [];

        const lessonsById = new Map(
            lessonDocuments.map(lesson => [String(lesson._id), lesson])
        );

        const ordersWithLessons = orders.map(order => {
            const selections = getSelectionsFromOrder(order);

            const lessons = selections
                .map(selection => {
                    const lesson = lessonsById.get(selection.lessonId);

                    if (!lesson) return null;

                    const options = getScheduleOptions(lesson);
                    const option = options.find(item => item.id === selection.optionId)
                        || options[0];

                    if (!option) return null;

                    return {
                        ...lesson,
                        _id: String(lesson._id),
                        scheduleOptionId: option.id,
                        scheduleOptionLabel: option.label,
                        space: option.space,
                        sessions: option.sessions
                    };
                })
                .filter(Boolean);

            return {
                _id: String(order._id),
                createdAt: order.createdAt,
                paymentMethod: order.paymentMethod,
                lessons
            };
        });

        res.json(ordersWithLessons);
    } catch (error) {
        console.error("Could not get orders:", error);
        res.status(500).json({ error: "Could not get orders." });
    }
});

// Reschedule one lesson to another lesson or timetable option.
app.put("/orders/:id/reschedule", async (req, res) => {
    const { id } = req.params;
    const phone = String(req.body.phone || "").trim();
    const oldLessonId = String(req.body.oldLessonId || "");
    const newLessonId = String(req.body.newLessonId || "");
    const oldOptionId = String(
        req.body.oldOptionId || req.body.oldScheduleOptionId || ""
    );
    const newOptionId = String(
        req.body.newOptionId || req.body.newScheduleOptionId || ""
    );

    if (
        !ObjectId.isValid(id)
        || !ObjectId.isValid(oldLessonId)
        || !ObjectId.isValid(newLessonId)
    ) {
        return res.status(400).json({
            error: "Invalid order or lesson ID."
        });
    }

    if (!phone) {
        return res.status(400).json({ error: "Phone number is required." });
    }

    try {
        const orderCollection = db.collection("order");
        const order = await orderCollection.findOne({
            _id: new ObjectId(id),
            phone
        });

        if (!order) {
            return res.status(404).json({ error: "Order not found." });
        }

        const selections = getSelectionsFromOrder(order);
        const oldIndex = selections.findIndex(selection =>
            selection.lessonId === oldLessonId
            && (!oldOptionId || selection.optionId === oldOptionId)
        );

        if (oldIndex === -1) {
            return res.status(404).json({
                error: "That lesson is not in this order."
            });
        }

        const newLesson = await db.collection("Lessons").findOne({
            _id: new ObjectId(newLessonId)
        });

        if (!newLesson) {
            return res.status(404).json({ error: "New lesson not found." });
        }

        const newOptions = getScheduleOptions(newLesson);
        const chosenNewOption = newOptionId
            ? newOptions.find(option => option.id === newOptionId)
            : newOptions[0];

        if (!chosenNewOption) {
            return res.status(404).json({
                error: "Choose an available timetable option."
            });
        }

        const oldSelection = selections[oldIndex];

        if (
            oldSelection.lessonId === newLessonId
            && oldSelection.optionId === chosenNewOption.id
        ) {
            return res.status(400).json({
                error: "Choose a different timetable option."
            });
        }

        const reservation = await reserveScheduleOption(
            newLessonId,
            chosenNewOption.id
        );

        if (!reservation.ok) {
            return res.status(409).json({ error: reservation.message });
        }

        const updatedSelections = [...selections];
        updatedSelections[oldIndex] = {
            lessonId: newLessonId,
            optionId: chosenNewOption.id
        };

        const updatedLessonIDs = updatedSelections.map(
            selection => selection.lessonId
        );

        const updateResult = await orderCollection.updateOne(
            { _id: order._id, phone },
            {
                $set: {
                    lessonSelections: updatedSelections,
                    lessonIDs: updatedLessonIDs,
                    updatedAt: new Date()
                }
            }
        );

        if (updateResult.matchedCount === 0) {
            await restoreScheduleOption(newLessonId, chosenNewOption.id);

            return res.status(409).json({
                error: "The order changed. Please try again."
            });
        }

        await restoreScheduleOption(
            oldSelection.lessonId,
            oldSelection.optionId
        );

        res.json({ message: "Order rescheduled successfully." });
    } catch (error) {
        console.error("Could not reschedule order:", error);
        res.status(500).json({
            error: "Could not reschedule the order."
        });
    }
});

// Cancel an order and restore all its selected timetable spaces.
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
        const orderCollection = db.collection("order");
        const order = await orderCollection.findOne({
            _id: new ObjectId(id),
            phone
        });

        if (!order) {
            return res.status(404).json({ error: "Order not found." });
        }

        await orderCollection.deleteOne({ _id: order._id });

        for (const selection of getSelectionsFromOrder(order)) {
            await restoreScheduleOption(
                selection.lessonId,
                selection.optionId
            );
        }

        res.json({
            message: "Order cancelled and timetable spaces restored."
        });
    } catch (error) {
        console.error("Could not cancel order:", error);
        res.status(500).json({ error: "Could not cancel the order." });
    }
});

// Update spaces for an older client or for one specific timetable option.
app.put("/lessons/:id", async (req, res) => {
    const { id } = req.params;
    const space = Number(req.body.space);
    const scheduleOptionId = String(req.body.scheduleOptionId || "");

    if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid lesson ID." });
    }

    if (!Number.isInteger(space) || space < 0) {
        return res.status(400).json({
            error: "Space must be a non-negative whole number."
        });
    }

    try {
        let result;

        if (scheduleOptionId) {
            result = await db.collection("Lessons").updateOne(
                {
                    _id: new ObjectId(id),
                    "scheduleOptions.id": scheduleOptionId
                },
                {
                    $set: { "scheduleOptions.$.space": space }
                }
            );
        } else {
            result = await db.collection("Lessons").updateOne(
                { _id: new ObjectId(id) },
                { $set: { space } }
            );
        }

        if (result.matchedCount === 0) {
            return res.status(404).json({
                error: "Lesson or timetable option not found."
            });
        }

        res.json({ message: "Lesson spaces updated." });
    } catch (error) {
        console.error("Could not update lesson spaces:", error);
        res.status(500).json({
            error: "Could not update lesson spaces."
        });
    }
});

// Count the number of purchased slots for a lesson.
app.get("/enrolment/:lessonid", async (req, res) => {
    const lessonId = req.params.lessonid;

    if (!ObjectId.isValid(lessonId)) {
        return res.status(400).json({ error: "Invalid lesson ID." });
    }

    try {
        const orders = await db.collection("order").find({}).toArray();

        const enrolment = orders.reduce((total, order) => {
            const selections = getSelectionsFromOrder(order);

            return total + selections.filter(
                selection => selection.lessonId === lessonId
            ).length;
        }, 0);

        res.json({ lessonId, enrolment });
    } catch (error) {
        console.error("Could not get enrolment:", error);
        res.status(500).json({ error: "Could not get enrolment." });
    }
});

// Get notifications for a phone number.
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

// Save a notification.
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

// Mark all notifications as read.
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
        console.error("Could not mark notifications as read:", error);
        res.status(500).json({
            error: "Could not update notifications."
        });
    }
});

// Mark one notification as read.
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
        res.status(500).json({
            error: "Could not update the notification."
        });
    }
});

// Delete one notification.
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

// Clear all notifications for a phone number.
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