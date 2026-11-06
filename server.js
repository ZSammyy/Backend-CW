require("dotenv").config();
const express = require("express");
const { MongoClient } = require("mongodb");
const app = express();
const port = 3000;
const client = new MongoClient(process.env.MONGODB_URI);
const dbName = "CWhubbases";
app.use(express.json());
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});
app.get("/", (req, res) => {
  res.send("After-school app server is running.");
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});