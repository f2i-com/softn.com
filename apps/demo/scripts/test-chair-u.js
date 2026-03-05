const logic = require('fs').readFileSync('bundles/TheOffice/logic/main.logic', 'utf8');
console.log(logic.match(/CHAIR_U/g));
