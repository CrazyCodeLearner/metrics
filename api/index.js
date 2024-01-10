import express from "express";
import handleIsocalendar from "./isocalender.js";

const app = express();
const port = 3000;

// Define a route that renders an EJS template
app.get("/", handleIsocalendar);

// Start the server
app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
