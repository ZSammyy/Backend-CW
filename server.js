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
  res.send("After-school app server is running.");
});

async function startServer() {
  try {
    await client.connect();
    console.log("Connected to MongoDB Atlas");
    
    // Initialize the database reference after the connection succeeds
    const db = client.db(dbName);

    // Route to fetch all documents from the "lessons" collection
    app.get("/lessons", async (req, res) => {
      try {
        const lessons = await db.collection("lessons").find({}).toArray();
        res.json(lessons);
      } catch (error) {
        res.status(500).json({ error: error.message });
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