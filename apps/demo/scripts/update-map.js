const fs = require('fs');

let logic = fs.readFileSync('bundles/TheOffice/logic/main.logic', 'utf8');

// Plants
logic = logic.replace(/setTile\(obj, col, 1, 1, PLANT\)/g, "place1x2At(obj, col, 1, 0, PLANT_T, PLANT_B)");
logic = logic.replace(/setTile\(obj, col, 26, 1, PLANT\)/g, "place1x2At(obj, col, 26, 0, PLANT_T, PLANT_B)");
logic = logic.replace(/setTile\(obj, col, 17, 6, PLANT\)/g, "place1x2At(obj, col, 17, 5, PLANT_T, PLANT_B)");
logic = logic.replace(/setTile\(obj, col, 26, 5, PLANT\)/g, "place1x2At(obj, col, 26, 4, PLANT_T, PLANT_B)");
logic = logic.replace(/setTile\(obj, col, 1, 18, PLANT\)/g, "place1x2At(obj, col, 1, 17, PLANT_T, PLANT_B)");
logic = logic.replace(/setTile\(obj, col, 26, 18, PLANT\)/g, "place1x2At(obj, col, 26, 17, PLANT_T, PLANT_B)");
logic = logic.replace(/setTile\(obj, col, 23, 14, PLANT\)/g, "place1x2At(obj, col, 23, 13, PLANT_T, PLANT_B)");

// Chair R / L (Conference room)
logic = logic.replace(/setTile\(obj, col, 20, 1, CHAIR_R\)\n\s+setTile\(obj, col, 20, 2, CHAIR_R\)/g, "place1x2At(obj, col, 20, 1, CHAIR_R_T, CHAIR_R_B)");
logic = logic.replace(/setTile\(obj, col, 23, 1, CHAIR_L\)\n\s+setTile\(obj, col, 23, 2, CHAIR_L\)/g, "place1x2At(obj, col, 23, 1, CHAIR_L_T, CHAIR_L_B)");

// Chair D
// Open Plan Workstations
logic = logic.replace(/setTile\(obj, col, (\d+), (\d+), CHAIR_D\)/g, "place1x2At(obj, col, $1, $2, CHAIR_D_T, CHAIR_D_B)");

fs.writeFileSync('bundles/TheOffice/logic/main.logic', logic);
