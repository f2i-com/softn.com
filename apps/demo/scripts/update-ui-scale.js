const fs = require('fs');
let ui = fs.readFileSync('bundles/TheOffice/ui/main.ui', 'utf8');

ui = ui.replace(/<Sprite (.*?) scale=\{1.8\} (.*?)\/>/g, "<Sprite $1 scale={2.4} $2/>");

fs.writeFileSync('bundles/TheOffice/ui/main.ui', ui);
