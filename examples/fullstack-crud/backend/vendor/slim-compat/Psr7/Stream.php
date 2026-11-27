<?php
namespace SlimCompat\Psr7;

/** Lightweight PSR-7 compatible memory stream for SoftN PHP SAPI containers. */
class Stream
{
    private $contents = '';

    public function __construct($initial = '')
    {
        $this->contents = (string) $initial;
    }

    public function write($string)
    {
        $str = (string) $string;
        $this->contents .= $str;
        return strlen($str);
    }

    public function getContents()
    {
        return $this->contents;
    }

    public function getSize()
    {
        return strlen($this->contents);
    }

    public function __toString()
    {
        return $this->contents;
    }
}
