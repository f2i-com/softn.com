<?php
declare(strict_types=1);
function sanitize_photo(mixed $url): array {
    if(!is_string($url)||strlen($url)>5600000||!preg_match('~^data:image/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$~D',$url,$match))throw new RuntimeException('format');
    $data=base64_decode($match[2],true);
    if($data===false||strlen($data)>4000000)throw new RuntimeException('size');
    $size=@getimagesizefromstring($data);
    if(!$size||$size[0]<32||$size[1]<32||$size[0]*$size[1]>16000000||!in_array($size[2],[IMAGETYPE_JPEG,IMAGETYPE_PNG,IMAGETYPE_WEBP],true))throw new RuntimeException('dimensions');
    if(($size[2]===IMAGETYPE_PNG&&str_contains($data,'acTL'))||($size[2]===IMAGETYPE_WEBP&&str_contains($data,'ANIM')))throw new RuntimeException('animation');
    $image=@imagecreatefromstring($data);if(!$image)throw new RuntimeException('decode');
    try {
        $result=['sanitized'=>true];
        foreach(['thumbnail'=>240,'image'=>960] as $field=>$side) {
            $ratio=min(1,$side/imagesx($image),$side/imagesy($image));
            $w=max(1,(int)floor(imagesx($image)*$ratio));$h=max(1,(int)floor(imagesy($image)*$ratio));
            $copy=imagecreatetruecolor($w,$h);
            try {
                imagefill($copy,0,0,imagecolorallocate($copy,255,255,255));
                imagecopyresampled($copy,$image,0,0,0,0,$w,$h,imagesx($image),imagesy($image));
                ob_start();try{imagejpeg($copy,null,82);$bytes=ob_get_contents();}finally{ob_end_clean();}
                if(strlen($bytes)>($field==='thumbnail'?60000:400000))throw new RuntimeException('complexity');
                $result[$field]='data:image/jpeg;base64,'.base64_encode($bytes);
            } finally {imagedestroy($copy);}
        }
        return $result;
    } finally {imagedestroy($image);}
}
