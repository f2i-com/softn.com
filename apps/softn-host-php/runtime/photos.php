<?php
declare(strict_types=1);

/**
 * The EXIF orientation of a JPEG, 1 to 8, or 1 when it carries none.
 *
 * A phone held upright records its sensor's rows as they come and says
 * "turn this a quarter" in EXIF. GD decodes the pixels and ignores the note,
 * and the copy written below has no EXIF at all, so a portrait photo came out
 * of this host lying on its side; the Rust host turns it. Read by hand rather
 * than with exif_read_data(): exif is not an extension this host asks for.
 * Metadata that cannot be read is no orientation, not a reason to refuse.
 */
function photo_orientation(string $data): int {
    $length=strlen($data);
    if($length<4||$data[0]!=="\xFF"||$data[1]!=="\xD8")return 1;
    for($at=2;$at+4<=$length&&$data[$at]==="\xFF";) {
        $marker=ord($data[$at+1]);
        if($marker===0xFF){$at++;continue;} // padding
        if($marker===0x01||($marker>=0xD0&&$marker<=0xD8)){$at+=2;continue;} // no length
        if($marker===0xDA||$marker===0xD9)break; // image data: no metadata follows
        $size=(ord($data[$at+2])<<8)|ord($data[$at+3]);
        if($size<2||$at+2+$size>$length)break;
        if($marker===0xE1&&substr($data,$at+4,6)==="Exif\0\0")return tiff_orientation(substr($data,$at+10,$size-8));
        $at+=2+$size;
    }
    return 1;
}

/** Tag 0x0112 of a TIFF header's first directory, when it is a SHORT from 1 to 8. */
function tiff_orientation(string $tiff): int {
    $length=strlen($tiff);
    if($length<14)return 1;
    $order=substr($tiff,0,2);
    if($order!=='II'&&$order!=='MM')return 1;
    $u16=$order==='II'?'v':'n';$u32=$order==='II'?'V':'N';
    if(unpack($u16,$tiff,2)[1]!==42)return 1;
    $directory=unpack($u32,$tiff,4)[1];
    if($directory<8||$directory+2>$length)return 1;
    $count=unpack($u16,$tiff,$directory)[1];
    for($i=0;$i<$count;$i++) {
        $entry=$directory+2+12*$i;
        if($entry+12>$length)return 1;
        if(unpack($u16,$tiff,$entry)[1]!==0x0112)continue;
        $value=unpack($u16,$tiff,$entry+8)[1];
        return unpack($u16,$tiff,$entry+2)[1]===3&&$value>=1&&$value<=8?$value:1;
    }
    return 1;
}

/** The image as it is meant to be seen. imagerotate() turns counter-clockwise. */
function photo_upright(GdImage $image, int $orientation): GdImage {
    $turn=[3=>180,5=>270,6=>270,7=>270,8=>90][$orientation]??0;
    if($turn!==0){$turned=imagerotate($image,$turn,0);if(!$turned)throw new RuntimeException('orientation');$image=$turned;}
    $flip=[2=>IMG_FLIP_HORIZONTAL,4=>IMG_FLIP_VERTICAL,5=>IMG_FLIP_HORIZONTAL,7=>IMG_FLIP_VERTICAL][$orientation]??null;
    if($flip!==null)imageflip($image,$flip);
    return $image;
}

/**
 * Whether a PNG is an animated one: it carries an `acTL` chunk, which APNG
 * puts among the chunks before the image data.
 *
 * The check used to be "the bytes acTL anywhere in the file". A still photo
 * with those letters in a comment was refused as animated, and so was about
 * one 4 MB PNG in a thousand, whose compressed pixels spell them by chance.
 * The Rust host reads the chunks, and takes both.
 */
function png_is_animated(string $data): bool {
    $length=strlen($data);
    for($at=8;$at+8<=$length;) {
        $type=substr($data,$at+4,4);
        if($type==='acTL')return true;
        if($type==='IDAT'||$type==='IEND')return false;
        $at+=12+unpack('N',$data,$at)[1];
    }
    return false;
}

function sanitize_photo(mixed $url): array {
    if(!is_string($url)||strlen($url)>5600000||!preg_match('~^data:image/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$~D',$url,$match))throw new RuntimeException('format');
    $data=base64_decode($match[2],true);
    if($data===false||strlen($data)>4000000)throw new RuntimeException('size');
    $size=@getimagesizefromstring($data);
    if(!$size||$size[0]<32||$size[1]<32||$size[0]>8192||$size[1]>8192||$size[0]*$size[1]>16000000||!in_array($size[2],[IMAGETYPE_JPEG,IMAGETYPE_PNG,IMAGETYPE_WEBP],true))throw new RuntimeException('dimensions');
    // $size[2] is what the bytes are, whatever the label called them: a PNG a
    // browser labelled image/jpeg (it goes by the file's extension) is a PNG.
    if(($size[2]===IMAGETYPE_PNG&&png_is_animated($data))||($size[2]===IMAGETYPE_WEBP&&str_contains($data,'ANIM')))throw new RuntimeException('animation');
    $image=@imagecreatefromstring($data);if(!$image)throw new RuntimeException('decode');
    $orientation=$size[2]===IMAGETYPE_JPEG?photo_orientation($data):1;
    try {
        $result=['sanitized'=>true];
        foreach(['thumbnail'=>240,'image'=>960] as $field=>$side) {
            $ratio=min(1,$side/imagesx($image),$side/imagesy($image));
            $w=max(1,(int)floor(imagesx($image)*$ratio));$h=max(1,(int)floor(imagesy($image)*$ratio));
            $copy=imagecreatetruecolor($w,$h);
            try {
                imagefill($copy,0,0,imagecolorallocate($copy,255,255,255));
                imagecopyresampled($copy,$image,0,0,0,0,$w,$h,imagesx($image),imagesy($image));
                // Turned after it is made small: a 16 megapixel original is not held twice.
                $copy=photo_upright($copy,$orientation);
                ob_start();try{imagejpeg($copy,null,82);$bytes=ob_get_contents();}finally{ob_end_clean();}
                if(strlen($bytes)>($field==='thumbnail'?60000:400000))throw new RuntimeException('complexity');
                $result[$field]='data:image/jpeg;base64,'.base64_encode($bytes);
            } finally {unset($copy);} // A GdImage frees itself; imagedestroy() has been a no-op since PHP 8.0.
        }
        return $result;
    } finally {unset($image);}
}
