require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");

const app = express();
const port = process.env.PORT || 3000; // Uses environment port or defaults to 3000
const client = new MongoClient(process.env.MONGODB_URI);
const dbName = "CWhubbase";

app.use(cors()); // Allows cross-origin requests from your frontend
app.use(express.json()); // Parses incoming JSON payloads in req.body

// Logger middleware: prints the timestamp, HTTP method, and requested URL
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next(); // Passes control to the next middleware
});

// Static file middleware: serves files from the "public" folder
app.use(express.static("public")); 

// Base route to confirm the server is alive
app.get("/", (req, res) => {
  res.send("CWhub app server is running.");
});

async function startServer() {
  try {
    await client.connect();
    console.log("Connected to MongoDB Atlas");
    
    // Initialize the database reference after the connection succeeds
    const db = client.db(dbName);

    // Route to fetch all documents from the "Lessons" collection
    app.get("/Lessons", async (req, res) => {
      try {
        const lessons = await db.collection("Lessons").find({}).toArray();
        res.json(lessons);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    app.post("/orders", async (req, res) => {
      try {
        const { name, phone, lessonIDs } = req.body;
        
        if (!name || !phone || !Array.isArray(lessonIDs) || lessonIDs.length === 0) {
          return res.status(400).json({ error: "Name, phone, and lessons are required." });
        
        }
        
        const result = await db.collection("order").insertOne({
          name,
          phone,
          lessonIDs,
          spaces: lessonIDs.length,
          createdAt: new Date()
        });
        
        res.status(201).json({ message: "Order saved", orderId: result.insertedId });
      } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Could not save the order." });
      }
    });


    // Start listening for incoming requests
    app.listen(port, () => {
      console.log(`Server running at http://localhost:${port}`);
    });
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
  }
}

startServer();