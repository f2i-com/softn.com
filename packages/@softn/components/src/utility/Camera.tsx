/**
 * Camera Component
 *
 * Versatile camera component supporting photo capture, video recording,
 * and live frame streaming. Uses getUserMedia, canvas capture, and
 * MediaRecorder APIs.
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';

export interface CameraProps {
  /** Operating mode (default 'photo') */
  mode?: 'photo' | 'video' | 'live';
  /** Camera facing mode (default 'user') */
  facing?: 'user' | 'environment';
  /** Video width in pixels (default 640) */
  width?: number;
  /** Video height in pixels (default 480) */
  height?: number;
  /** Frame rate for live mode, in fps (default 10) */
  frameRate?: number;
  /** JPEG quality 0-1 (default 0.7) */
  quality?: number;
  /** Whether the camera is active (default true) */
  active?: boolean;
  /** Whether to show built-in controls (default true) */
  showControls?: boolean;
  /** Called when a photo is captured */
  onCapture?: (data: { dataUrl: string; width: number; height: number }) => void;
  /** Called on each live frame */
  onFrame?: (data: { dataUrl: string; width: number; height: number; timestamp: number }) => void;
  /** Called when video recording completes */
  onRecord?: (data: { dataUrl: string; duration: number; mimeType: string }) => void;
  /** Called when an error occurs */
  onError?: (error: string) => void;
  /** Inline styles */
  style?: React.CSSProperties;
  /** Children rendered as overlay */
  children?: React.ReactNode;
}

export function Camera({
  mode = 'photo',
  facing = 'user',
  width = 640,
  height = 480,
  frameRate = 10,
  quality = 0.7,
  active = true,
  showControls = true,
  onCapture,
  onFrame,
  onRecord,
  onError,
  style,
  children,
}: CameraProps): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const frameIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordStartRef = useRef<number>(0);
  const chunksRef = useRef<Blob[]>([]);

  const [isStreaming, setIsStreaming] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flashVisible, setFlashVisible] = useState(false);

  // Stop all resources
  const cleanup = useCallback(() => {
    if (frameIntervalRef.current) {
      clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
      recorderRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setIsStreaming(false);
    setIsRecording(false);
  }, []);

  // Start camera stream
  const startCamera = useCallback(async () => {
    cleanup();

    if (!active) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: facing,
          width: { ideal: width },
          height: { ideal: height },
        },
        audio: mode === 'video',
      });

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      setIsStreaming(true);
      setError(null);

      // Start live frame capture if in live mode
      if (mode === 'live' && onFrame) {
        const intervalMs = Math.max(16, Math.round(1000 / frameRate));
        frameIntervalRef.current = setInterval(() => {
          captureFrame();
        }, intervalMs);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to access camera';
      setError(message);
      onError?.(message);
    }
  }, [active, facing, width, height, mode, frameRate, onFrame, onError, cleanup]);

  // Capture a single frame to canvas -> data URL
  const captureFrame = useCallback((): { dataUrl: string; width: number; height: number } | null => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) return null;

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    canvas.width = vw;
    canvas.height = vh;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, vw, vh);
    const dataUrl = canvas.toDataURL('image/jpeg', quality);

    return { dataUrl, width: vw, height: vh };
  }, [quality]);

  // Live frame capture
  useEffect(() => {
    if (mode === 'live' && isStreaming && onFrame && !frameIntervalRef.current) {
      const intervalMs = Math.max(16, Math.round(1000 / frameRate));
      frameIntervalRef.current = setInterval(() => {
        const frame = captureFrame();
        if (frame) {
          onFrame({ ...frame, timestamp: Date.now() });
        }
      }, intervalMs);
    }

    return () => {
      if (frameIntervalRef.current) {
        clearInterval(frameIntervalRef.current);
        frameIntervalRef.current = null;
      }
    };
  }, [mode, isStreaming, onFrame, frameRate, captureFrame]);

  // Take a photo
  const takePhoto = useCallback(() => {
    const frame = captureFrame();
    if (frame) {
      // Flash effect
      setFlashVisible(true);
      setTimeout(() => setFlashVisible(false), 150);
      onCapture?.(frame);
    }
  }, [captureFrame, onCapture]);

  // Start video recording
  const startRecording = useCallback(() => {
    if (!streamRef.current) return;

    chunksRef.current = [];
    recordStartRef.current = Date.now();

    // Choose best supported mime type
    const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
      .find((t) => MediaRecorder.isTypeSupported(t)) || 'video/webm';

    try {
      const recorder = new MediaRecorder(streamRef.current, { mimeType: mimeType.split(';')[0] });

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        const duration = Date.now() - recordStartRef.current;
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        const reader = new FileReader();
        reader.onloadend = () => {
          const dataUrl = reader.result as string;
          onRecord?.({ dataUrl, duration, mimeType: recorder.mimeType });
        };
        reader.readAsDataURL(blob);
        chunksRef.current = [];
        setIsRecording(false);
      };

      recorder.start(100); // collect data every 100ms
      recorderRef.current = recorder;
      setIsRecording(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start recording';
      setError(message);
      onError?.(message);
    }
  }, [onRecord, onError]);

  // Stop video recording
  const stopRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
  }, []);

  // Start/stop camera based on active prop and facing changes
  useEffect(() => {
    if (active) {
      startCamera();
    } else {
      cleanup();
    }
    return cleanup;
  }, [active, facing, mode]);

  // Styles
  const containerStyle: React.CSSProperties = {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    width,
    borderRadius: '0.5rem',
    backgroundColor: '#000',
    ...style,
  };

  const videoStyle: React.CSSProperties = {
    display: 'block',
    width: '100%',
    height: 'auto',
    objectFit: 'cover',
    transform: facing === 'user' ? 'scaleX(-1)' : undefined,
  };

  const controlsStyle: React.CSSProperties = {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.75rem',
    padding: '0.75rem',
    width: '100%',
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    zIndex: 20,
  };

  const buttonBaseStyle: React.CSSProperties = {
    border: 'none',
    borderRadius: '50%',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'transform 0.1s, opacity 0.1s',
  };

  const captureButtonStyle: React.CSSProperties = {
    ...buttonBaseStyle,
    width: 56,
    height: 56,
    backgroundColor: mode === 'video' && isRecording ? '#ef4444' : '#fff',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
  };

  const captureInnerStyle: React.CSSProperties = {
    width: isRecording ? 20 : 44,
    height: isRecording ? 20 : 44,
    borderRadius: isRecording ? 4 : '50%',
    backgroundColor: mode === 'video' && !isRecording ? '#ef4444' : mode === 'video' ? '#fff' : '#e5e5e5',
    border: mode === 'video' && !isRecording ? 'none' : '3px solid #fff',
    transition: 'all 0.15s',
  };

  const flashStyle: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    backgroundColor: '#fff',
    opacity: flashVisible ? 0.8 : 0,
    transition: 'opacity 0.15s',
    pointerEvents: 'none',
    zIndex: 10,
  };

  if (error) {
    return (
      <div style={containerStyle}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width,
            height,
            padding: '1rem',
            textAlign: 'center',
            color: '#ef4444',
            fontSize: '0.875rem',
          }}
        >
          {error}
        </div>
      </div>
    );
  }

  const handleMainButton = () => {
    if (mode === 'photo') {
      takePhoto();
    } else if (mode === 'video') {
      if (isRecording) {
        stopRecording();
      } else {
        startRecording();
      }
    }
    // Live mode has no main button action
  };

  return (
    <div style={containerStyle}>
      <video
        ref={videoRef}
        style={videoStyle}
        playsInline
        muted
        autoPlay
      />
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {/* Flash overlay for photo capture */}
      <div style={flashStyle} />

      {/* Children overlay */}
      {children && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 5 }}>
          {children}
        </div>
      )}

      {/* Recording indicator */}
      {isRecording && (
        <div
          style={{
            position: 'absolute',
            top: 12,
            left: 12,
            display: 'flex',
            alignItems: 'center',
            gap: '0.375rem',
            padding: '0.25rem 0.625rem',
            borderRadius: '1rem',
            backgroundColor: 'rgba(239, 68, 68, 0.85)',
            color: '#fff',
            fontSize: '0.75rem',
            fontWeight: 600,
            zIndex: 10,
          }}
        >
          <span
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              backgroundColor: '#fff',
              animation: 'softn-cam-blink 1s infinite',
            }}
          />
          REC
        </div>
      )}

      {/* Status bar */}
      {!isStreaming && active && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            color: '#fff',
            fontSize: '0.875rem',
          }}
        >
          Starting camera...
        </div>
      )}

      {/* Controls */}
      {showControls && isStreaming && (mode === 'photo' || mode === 'video') && (
        <div style={controlsStyle}>
          <button
            type="button"
            style={captureButtonStyle}
            onClick={handleMainButton}
            title={
              mode === 'photo'
                ? 'Take Photo'
                : isRecording
                  ? 'Stop Recording'
                  : 'Start Recording'
            }
          >
            <div style={captureInnerStyle} />
          </button>
        </div>
      )}

      {/* Blink animation for recording indicator */}
      <style>{`
        @keyframes softn-cam-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}

export default Camera;
