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

app.get("/", (req, res) => {
  res.send("CWhub server is running.");
});

async function startServer() {
  try {
    await client.connect();
    console.log("Connected to MongoDB Atlas");

    db = client.db(dbName);

    app.listen(port, () => {
      console.log(`Server running at http://localhost:${port}`);
    });
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
  }
}

startServer();