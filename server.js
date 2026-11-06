const express = require("express");

const app = express();
const port = 3000;

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
app.get("/lessons", (req, res) => {
  res.json([
    { topic: "Maths", location: "Hendon", price: 12, space: 5 },
    { topic: "Robotics", location: "Colindale", price: 15, space: 5 },
  ]);
});