export default {
  async render(el){
    el.innerHTML = `
      <p>Guiding services.</p>
      <ul style="margin:0;padding-left:18px">
        <li>Online guiding</li>
        <li>Live online guiding</li>
        <li>IRL tours</li>
      </ul>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="create-guide">Create content</button>
        <button class="btn" id="manage-guide">Manage catalog</button>
      </div>
    `;
  }
};
