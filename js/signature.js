// Campo de assinatura com o dedo / mouse (canvas + pointer events).
export class SignaturePad {
  constructor(canvas, { onChange } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onChange = onChange;
    this.inkLength = 0;
    this.last = null;
    this.setup();

    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      this.last = this.point(e);
      this.dot(this.last);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.last) return;
      const p = this.point(e);
      this.ctx.beginPath();
      this.ctx.moveTo(this.last.x, this.last.y);
      this.ctx.lineTo(p.x, p.y);
      this.ctx.stroke();
      this.inkLength += Math.hypot(p.x - this.last.x, p.y - this.last.y);
      this.last = p;
      this.onChange?.(this.isEmpty());
    });
    const end = () => { this.last = null; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  setup() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.fillStyle = '#fff';
    this.ctx.fillRect(0, 0, rect.width, rect.height);
    this.ctx.lineWidth = 2.6;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.strokeStyle = '#0b1220';
    this.ctx.fillStyle = '#0b1220';
  }

  point(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  dot(p) {
    this.ctx.beginPath();
    this.ctx.arc(p.x, p.y, 1.3, 0, Math.PI * 2);
    this.ctx.fill();
  }

  /** Um rabisco mínimo é exigido para evitar "assinaturas" acidentais com um toque. */
  isEmpty() {
    return this.inkLength < 40;
  }

  clear() {
    this.inkLength = 0;
    this.setup();
    this.onChange?.(true);
  }

  /** Exporta em tamanho reduzido para economizar espaço no aparelho. */
  toDataURL() {
    const w = 360;
    const h = Math.round((this.canvas.height / this.canvas.width) * w);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    out.getContext('2d').drawImage(this.canvas, 0, 0, w, h);
    return out.toDataURL('image/jpeg', 0.6);
  }
}
