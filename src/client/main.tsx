import { createRoot } from "react-dom/client";
import "./styles.css";
import { Reader } from "./components/Reader";
import { applyDocumentLocale } from "./i18n";

applyDocumentLocale();

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<Reader />);
}
