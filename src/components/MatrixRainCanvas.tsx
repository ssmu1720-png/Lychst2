import { useEffect, useRef } from 'react';

interface MatrixRainCanvasProps {
  intensity: 'full' | 'subtle' | 'off';
  hasAlert?: boolean;
}

const GLYPHS = '01LYRIHOSTABCDEF0123456789<>{}[]/*-+:=#';

export function MatrixRainCanvas({ intensity, hasAlert = false }: MatrixRainCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (intensity === 'off') return;
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId = 0;
    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);

    const fontSize = 12;
    let columns = Math.floor(width / fontSize);
    let drops: number[] = Array.from({ length: columns }, () => Math.random() * -40);
    let columnModes: Array<'crimson' | 'scarlet' | 'rose'> = Array.from({ length: columns }, (_, i) => {
      if (hasAlert && i % 7 === 0) return 'rose';
      if (i % 5 === 0) return 'rose';
      return i % 2 === 0 ? 'crimson' : 'scarlet';
    });

    const handleResize = () => {
      if (!canvas) return;
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
      columns = Math.floor(width / fontSize);
      drops = Array.from({ length: columns }, (_, i) => drops[i] ?? Math.random() * -40);
      columnModes = Array.from({ length: columns }, (_, i) => {
        if (hasAlert && i % 7 === 0) return 'rose';
        if (i % 5 === 0) return 'rose';
        return i % 2 === 0 ? 'crimson' : 'scarlet';
      });
    };

    window.addEventListener('resize', handleResize);

    let lastDraw = 0;
    const frameInterval = intensity === 'full' ? 58 : 85;

    const render = (time: number) => {
      animationFrameId = window.requestAnimationFrame(render);
      if (time - lastDraw < frameInterval) return;
      lastDraw = time;

      ctx.fillStyle = 'rgba(8, 3, 5, 0.14)';
      ctx.fillRect(0, 0, width, height);

      ctx.font = `${fontSize}px "IBM Plex Mono", monospace`;

      for (let i = 0; i < columns; i++) {
        const char = GLYPHS.charAt(Math.floor(Math.random() * GLYPHS.length));
        const x = i * fontSize;
        const y = drops[i] * fontSize;
        const mode = columnModes[i];

        if (mode === 'crimson') {
          ctx.fillStyle = intensity === 'full' ? 'rgba(239, 68, 68, 0.44)' : 'rgba(239, 68, 68, 0.2)';
        } else if (mode === 'scarlet') {
          ctx.fillStyle = intensity === 'full' ? 'rgba(185, 28, 28, 0.42)' : 'rgba(185, 28, 28, 0.18)';
        } else {
          ctx.fillStyle = intensity === 'full' ? 'rgba(251, 113, 133, 0.36)' : 'rgba(251, 113, 133, 0.15)';
        }

        ctx.fillText(char, x, y);

        if (y > height && Math.random() > 0.975) {
          drops[i] = 0;
        }
        drops[i] += 1;
      }
    };

    animationFrameId = window.requestAnimationFrame(render);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', handleResize);
    };
  }, [intensity, hasAlert]);

  if (intensity === 'off') return null;

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={`pointer-events-none fixed inset-0 z-0 transition-opacity duration-300 ${
        intensity === 'full' ? 'opacity-45' : 'opacity-20'
      }`}
    />
  );
}
