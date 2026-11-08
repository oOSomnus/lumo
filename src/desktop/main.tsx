import { createRoot } from "react-dom/client";
import "../client/styles.css";
import "./styles.css";
import { Launcher } from "./Launcher";

const container = document.getElementById("root");
if (container) createRoot(container).render(<Launcher />);
