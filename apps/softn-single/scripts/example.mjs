// Only generate the repository sample. Never replace an operator's bundle.
import fs from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
if (!fs.existsSync('public/app.softn'))
  fs.writeFileSync(
    'public/app.softn',
    zipSync(
      {
        'manifest.json': strToU8(
          JSON.stringify({
            name: 'Welcome',
            version: '1.0.0',
            main: 'ui/main.ui',
            files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'], assets: [], xdb: [] },
          })
        ),
        'permission.json': strToU8('{"permissions":{}}'),
        'logic/main.logic': strToU8(
          'let sampleClicks = 0\nfunction increment() { sampleClicks = sampleClicks + 1 }'
        ),
        'ui/main.ui': strToU8(
          '<logic src="../logic/main.logic" />\n<App><Box style={{display:"flex",flexDirection:"column",alignItems:"flex-start",gap:"16px",padding:"48px",maxWidth:"600px",margin:"auto"}}><Text style={{fontSize:"32px"}}>Welcome</Text><Text>Your application is ready.</Text><Button @click={increment}>{"Clicks: " + sampleClicks}</Button></Box></App>'
        ),
      },
      { level: 6 }
    )
  );
