import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/oswald/wght.css";
import "@fontsource/merriweather/400.css";
import "@fontsource/merriweather/700.css";
import "@fontsource/merriweather/400-italic.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import App from "./App.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(<App />);
