export default {
  async render(el){
    el.innerHTML = `
      <p>Events creation and management — sessions, tickets, capacity, check-in.</p>
      <button class="btn" id="new-event">Create Event</button>
    `;
  }
};
