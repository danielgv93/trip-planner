// Entry point. Importing the side-effect modules (dialogs, dnd, actions) wires
// every event listener; then the initial paint runs once, after the whole module
// graph has evaluated — so no cross-module call fires against a half-initialised
// binding.

import { render, applyTitle } from "./render.js";
import { drawMap } from "./map.js";
import "./dialogs.js";
import "./dnd.js";
import "./actions.js";

applyTitle();
render();
drawMap();
