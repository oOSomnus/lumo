import { createRoot } from "react-dom/client";
import "./styles.css";
import { Reader } from "./components/Reader";
import { applyDocumentLocale } from "./i18n";
// Paints the page in the system's light or dark theme until the library reports its choice.
import "./theme";

applyDocumentLocale();

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<Reader />);
}
