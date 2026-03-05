const fs = require('fs');

let logic = fs.readFileSync('bundles/TheOffice/logic/main.logic', 'utf8');

logic = logic.replace(/charDelays\[i\] = 5 \+ Math.floor\(Math.random\(\) \* 20\)/g, "charDelays[i] = 25 + Math.floor(Math.random() * 100)");
logic = logic.replace(/charDelays\[charIdx\] = 15 \+ Math.floor\(Math.random\(\) \* 30\)/g, "charDelays[charIdx] = 75 + Math.floor(Math.random() * 150)");
logic = logic.replace(/charDelays\[i\] = 25 \+ Math.floor\(Math.random\(\) \* 50\)/g, "charDelays[i] = 125 + Math.floor(Math.random() * 250)");
logic = logic.replace(/speakingDelay = 38/g, "speakingDelay = 190");

fs.writeFileSync('bundles/TheOffice/logic/main.logic', logic);
