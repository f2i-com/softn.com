/**
 * The photo a route with `upload: "photo"` hands its handler
 * (runtime/photos.php), run with the PHP on PATH.
 *
 * A phone held upright stores its sensor's rows as they come and notes the
 * turn in EXIF. GD decodes the pixels and ignores the note, and the copy this
 * host writes carries no EXIF, so a portrait photo reached the handler lying
 * on its side; the Rust host turns it. Each of the eight orientations is
 * checked here by where four coloured quarters end up.
 *
 * Skipped, with the reason, when PHP or its GD extension is not there.
 */
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const photos=fileURLToPath(new URL('../runtime/photos.php',import.meta.url));
const probe=spawnSync('php',['-r','echo extension_loaded("gd")&&function_exists("imagejpeg")&&function_exists("imagerotate")?"gd":"none";'],{encoding:'utf8'});
const skip=probe.status!==0?'php is not on PATH (install PHP 8.1+ to run this test)':probe.stdout!=='gd'?'this PHP has no GD with JPEG support':false;
if(skip)console.warn('WARNING: tests/photos.test.mjs skipped: '+skip);
const test=(name,fn)=>nodeTest(name,{skip},fn);

/**
 * In PHP: an 80x48 JPEG whose quarters are red, green (top) and blue, yellow
 * (bottom), given the EXIF each case asks for, through sanitize_photo().
 * Returns, per case, the size of what came out and the colour of each corner.
 */
function sanitize(cases) {
  const script=`
require ${JSON.stringify(photos)};
function exif_segment(int $o, bool $big): string {
  $tiff=$big ? "MM\\0\\x2A\\0\\0\\0\\x08"."\\0\\x01"."\\x01\\x12\\0\\x03\\0\\0\\0\\x01".pack('n',$o)."\\0\\0"."\\0\\0\\0\\0"
             : "II\\x2A\\0\\x08\\0\\0\\0"."\\x01\\0"."\\x12\\x01\\x03\\0\\x01\\0\\0\\0".pack('v',$o)."\\0\\0"."\\0\\0\\0\\0";
  $payload="Exif\\0\\0".$tiff;
  return "\\xFF\\xE1".pack('n',strlen($payload)+2).$payload;
}
function quarters(): string {
  $im=imagecreatetruecolor(80,48);
  imagefilledrectangle($im,0,0,39,23,imagecolorallocate($im,255,0,0));
  imagefilledrectangle($im,40,0,79,23,imagecolorallocate($im,0,255,0));
  imagefilledrectangle($im,0,24,39,47,imagecolorallocate($im,0,0,255));
  imagefilledrectangle($im,40,24,79,47,imagecolorallocate($im,255,255,0));
  ob_start();imagejpeg($im,null,95);return ob_get_clean();
}
function colour(GdImage $im,int $x,int $y): string {
  $c=imagecolorat($im,$x,$y);$r=($c>>16)&255;$g=($c>>8)&255;$b=$c&255;
  $best='';$d=PHP_INT_MAX;
  foreach(['R'=>[255,0,0],'G'=>[0,255,0],'B'=>[0,0,255],'Y'=>[255,255,0]] as $name=>[$cr,$cg,$cb]) {
    $e=($r-$cr)**2+($g-$cg)**2+($b-$cb)**2;if($e<$d){$d=$e;$best=$name;}
  }
  return $best;
}
$jpeg=quarters();$out=[];
foreach(json_decode(stream_get_contents(STDIN),true) as $case) {
  $data=$jpeg;
  if($case['exif']==='little'||$case['exif']==='big')$data="\\xFF\\xD8".exif_segment($case['orientation'],$case['exif']==='big').substr($jpeg,2);
  // An APP1 that says Exif and then stops, and one whose directory points past its end.
  if($case['exif']==='cut')$data="\\xFF\\xD8"."\\xFF\\xE1\\0\\x0AExif\\0\\0II"."\\xFF\\xE1\\0\\x10Exif\\0\\0MM\\0\\x2A\\0\\0\\xFF\\xFF".substr($jpeg,2);
  try {
    $r=sanitize_photo('data:image/jpeg;base64,'.base64_encode($data));
    $row=[];
    foreach(['image','thumbnail'] as $field) {
      $bytes=base64_decode(substr($r[$field],strlen('data:image/jpeg;base64,')));
      $im=imagecreatefromstring($bytes);$w=imagesx($im);$h=imagesy($im);
      $qx=intdiv($w,4);$qy=intdiv($h,4);
      $row[$field]=['w'=>$w,'h'=>$h,'corners'=>colour($im,$qx,$qy).colour($im,$w-1-$qx,$qy).colour($im,$qx,$h-1-$qy).colour($im,$w-1-$qx,$h-1-$qy),'exif'=>str_contains($bytes,'Exif')];
    }
    $out[]=$row;
  } catch(Throwable $e) { $out[]=['error'=>$e->getMessage()]; }
}
echo json_encode($out);`;
  const r=spawnSync('php',['-d','display_errors=stderr','-r',script],{input:JSON.stringify(cases),encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  assert.equal(r.stderr,'',r.stderr);
  return JSON.parse(r.stdout);
}

// Corners as top-left, top-right, bottom-left, bottom-right, once the stored
// rows (RG over BY) are shown the way each orientation says to show them.
const UPRIGHT={
  1:{w:80,h:48,corners:'RGBY'},
  2:{w:80,h:48,corners:'GRYB'}, // mirrored left to right
  3:{w:80,h:48,corners:'YBGR'}, // half a turn
  4:{w:80,h:48,corners:'BYRG'}, // mirrored top to bottom
  5:{w:48,h:80,corners:'RBGY'}, // mirrored across the falling diagonal
  6:{w:48,h:80,corners:'BRYG'}, // a quarter turn clockwise: a phone held upright
  7:{w:48,h:80,corners:'YGBR'}, // mirrored across the rising diagonal
  8:{w:48,h:80,corners:'GYRB'}, // a quarter turn counter-clockwise
};

test('a photo is turned the way its EXIF orientation says, in either byte order',()=>{
  const cases=[];
  for(const exif of ['little','big'])for(let orientation=1;orientation<=8;orientation++)cases.push({exif,orientation});
  const got=sanitize(cases);
  cases.forEach((c,i)=>{
    const want=UPRIGHT[c.orientation];
    for(const field of ['image','thumbnail']) {
      assert.deepEqual({w:got[i][field].w,h:got[i][field].h,corners:got[i][field].corners},want,`${field}, orientation ${c.orientation}, ${c.exif}-endian`);
      assert.equal(got[i][field].exif,false,'what is handed on carries no EXIF');
    }
  });
});

/** In PHP: why sanitize_photo() refuses each input, or 'accepted'. */
function refusals(names) {
  const script=`
require ${JSON.stringify(photos)};
function picture(int $w,int $h,string $type): string {
  $im=imagecreatetruecolor($w,$h);imagefilledrectangle($im,0,0,$w-1,$h-1,imagecolorallocate($im,40,120,200));
  ob_start();if($type==='png')imagepng($im);elseif($type==='webp')imagewebp($im);else imagejpeg($im,null,90);return ob_get_clean();
}
function url(string $bytes,string $type='jpeg'): string { return 'data:image/'.$type.';base64,'.base64_encode($bytes); }
$png=picture(64,64,'png');
// An animation control chunk straight after the header: what makes a PNG an APNG.
$apng=substr($png,0,33).pack('N',8).'acTL'.pack('NN',2,0).pack('N',crc32('acTL'.pack('NN',2,0))).substr($png,33);
$inputs=[
  'still jpeg'=>url(picture(64,64,'jpeg')),
  'still png'=>url($png,'png'),
  'animated png'=>url($apng,'png'),
  'not a string'=>null,
  'not a data url'=>'https://example.test/cat.jpg',
  'a type it does not take'=>'data:image/gif;base64,'.base64_encode('GIF89a'),
  'not base64'=>'data:image/jpeg;base64,@@@@',
  'not an image'=>url(str_repeat('x',500)),
  'too small'=>url(picture(20,20,'jpeg')),
  'too wide'=>url(picture(8200,32,'png'),'png'),
  'too long a url'=>'data:image/jpeg;base64,'.str_repeat('A',5600000),
];
if(function_exists('imagewebp')) {
  $webp=picture(64,64,'webp');
  $inputs['still webp']=url($webp,'webp');
  $inputs['animated webp']=url($webp.'ANIM','webp');
}
$out=[];
foreach(json_decode(stream_get_contents(STDIN),true) as $name) {
  if(!array_key_exists($name,$inputs)){$out[$name]='skipped';continue;}
  try { $r=sanitize_photo($inputs[$name]); $out[$name]=$r['sanitized']===true&&str_starts_with($r['image'],'data:image/jpeg;base64,')&&str_starts_with($r['thumbnail'],'data:image/jpeg;base64,')?'accepted':'odd'; }
  catch(Throwable $e) { $out[$name]=$e->getMessage(); }
}
echo json_encode($out);`;
  const r=spawnSync('php',['-d','display_errors=stderr','-d','memory_limit=512M','-r',script],{input:JSON.stringify(names),encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  assert.equal(r.stderr,'',r.stderr);
  return JSON.parse(r.stdout);
}

test('a still photo is taken, and each thing that is not one is refused for its own reason',()=>{
  const want={
    'still jpeg':'accepted','still png':'accepted','still webp':'accepted',
    'animated png':'animation','animated webp':'animation',
    'not a string':'format','not a data url':'format','a type it does not take':'format','not base64':'format','too long a url':'format',
    'not an image':'dimensions','too small':'dimensions','too wide':'dimensions',
  };
  const got=refusals(Object.keys(want));
  for(const [name,reason] of Object.entries(want))if(got[name]!=='skipped')assert.equal(got[name],reason,name);
  assert.equal(got['still jpeg'],'accepted');
});

test('a photo with no orientation, or with EXIF that cannot be read, is left as it is',()=>{
  const got=sanitize([{exif:'none'},{exif:'little',orientation:0},{exif:'big',orientation:9},{exif:'cut'}]);
  for(const row of got) {
    assert.equal(row.error,undefined,JSON.stringify(row));
    assert.deepEqual({w:row.image.w,h:row.image.h,corners:row.image.corners},UPRIGHT[1]);
  }
});
