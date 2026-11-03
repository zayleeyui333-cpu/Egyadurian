(() => {
  'use strict';

  if (document.getElementById('egya-ai-chat-root')) return;

  const root = document.createElement('div');
  root.id = 'egya-ai-chat-root';
  root.innerHTML = `
    <button class="egya-chat-launcher" type="button" aria-label="Buka chat EGYA AI" aria-expanded="false">
      <span class="egya-chat-launcher-icon" aria-hidden="true">✦</span>
      <span class="egya-chat-launcher-label">Tanya AI</span>
    </button>
    <section class="egya-chat-panel" aria-label="EGYA AI Assistant" aria-hidden="true">
      <header class="egya-chat-header">
        <div class="egya-chat-avatar" aria-hidden="true">E</div>
        <div class="egya-chat-heading">
          <strong>EGYA AI ASSISTANT</strong>
          <span><i></i> Siap membantu kamu</span>
        </div>
        <button class="egya-chat-close" type="button" aria-label="Tutup chat">×</button>
      </header>
      <div class="egya-chat-messages" aria-live="polite" aria-relevant="additions">
        <div class="egya-chat-message assistant">
          <div class="egya-chat-bubble">Halo! 👋 Selamat datang di EGYA DURIAN. Ada yang ingin kamu tanyakan tentang produk atau pemesanan?</div>
          <time>EGYA AI</time>
        </div>
      </div>
      <div class="egya-chat-quick-replies">
        <button type="button" data-question="Apa saja produk durian yang tersedia?">Daftar produk</button>
        <button type="button" data-question="Bagaimana cara pemesanan?">Cara pesan</button>
        <button type="button" data-question="Bagaimana cara menghubungi admin?">Hubungi admin</button>
      </div>
      <form class="egya-chat-form">
        <label class="egya-chat-sr-only" for="egya-chat-input">Tulis pesan</label>
        <input id="egya-chat-input" name="message" type="text" maxlength="500" autocomplete="off" placeholder="Tulis pertanyaan kamu..." required>
        <button type="submit" aria-label="Kirim pesan">➤</button>
      </form>
      <div class="egya-chat-footnote">Jawaban otomatis oleh AI · Untuk konfirmasi, hubungi admin</div>
    </section>
  `;
  document.body.appendChild(root);

  const launcher = root.querySelector('.egya-chat-launcher');
  const panel = root.querySelector('.egya-chat-panel');
  const closeButton = root.querySelector('.egya-chat-close');
  const messagesElement = root.querySelector('.egya-chat-messages');
  const form = root.querySelector('.egya-chat-form');
  const input = root.querySelector('#egya-chat-input');
  const quickReplies = root.querySelector('.egya-chat-quick-replies');
  const conversation = [];
  let busy = false;

  function setOpen(open) {
    root.classList.toggle('is-open', open);
    launcher.setAttribute('aria-expanded', String(open));
    panel.setAttribute('aria-hidden', String(!open));
    if (open) input.focus();
  }

  function addMessage(role, text) {
    const wrapper = document.createElement('div');
    wrapper.className = `egya-chat-message ${role}`;
    const bubble = document.createElement('div');
    bubble.className = 'egya-chat-bubble';
    bubble.textContent = text;
    const time = document.createElement('time');
    time.textContent = role === 'assistant' ? 'EGYA AI' : 'Kamu';
    wrapper.append(bubble, time);
    messagesElement.appendChild(wrapper);
    messagesElement.scrollTop = messagesElement.scrollHeight;
    return wrapper;
  }

  function setBusy(value) {
    busy = value;
    input.disabled = value;
    form.querySelector('button').disabled = value;
    quickReplies.querySelectorAll('button').forEach(button => { button.disabled = value; });
  }

  async function sendMessage(rawText) {
    const text = String(rawText || '').trim();
    if (!text || busy) return;

    addMessage('user', text);
    conversation.push({ role: 'user', content: text });
    input.value = '';
    setBusy(true);

    const typing = addMessage('assistant', 'Sedang mengetik…');
    typing.classList.add('is-typing');

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: conversation.slice(-12) }),
      });
      const data = await response.json().catch(() => ({}));
      typing.remove();
      if (!response.ok || !data.ok || typeof data.answer !== 'string') {
        throw new Error(data.message || 'Maaf, chat sedang tidak tersedia. Silakan hubungi admin.');
      }
      addMessage('assistant', data.answer);
      conversation.push({ role: 'assistant', content: data.answer });
      if (conversation.length > 12) conversation.splice(0, conversation.length - 12);
    } catch (error) {
      typing.remove();
      addMessage('assistant', `${error.message || 'Terjadi kendala.'} Admin WhatsApp: +62 813-7887-4840`);
    } finally {
      setBusy(false);
      input.focus();
    }
  }

  launcher.addEventListener('click', () => setOpen(!root.classList.contains('is-open')));
  closeButton.addEventListener('click', () => setOpen(false));
  form.addEventListener('submit', event => {
    event.preventDefault();
    sendMessage(input.value);
  });
  quickReplies.addEventListener('click', event => {
    const button = event.target.closest('button[data-question]');
    if (button) sendMessage(button.dataset.question);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && root.classList.contains('is-open')) setOpen(false);
  });
})();
