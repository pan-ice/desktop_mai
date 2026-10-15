import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Pet } from "./Pet";
import "./styles.css";

const isPet = new URLSearchParams(location.search).get("view") === "pet";
document.body.classList.toggle("pet-body", isPet);
document.documentElement.classList.toggle("pet-html", isPet);
createRoot(document.getElementById("root")!).render(isPet ? <Pet /> : <App />);
