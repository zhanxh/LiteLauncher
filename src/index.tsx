/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";

console.log("src/index.tsx executing render...");
render(() => <App />, document.getElementById("root") as HTMLElement);
console.log("src/index.tsx render call completed!");
