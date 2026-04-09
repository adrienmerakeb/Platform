export default {
  async render(el){
    el.innerHTML = `
      <div style="opacity:.9">
        <p>Manage virtual queues: create, schedule, set capacities, generate QR, monitor arrivals.</p>
        <button id="new-queue" class="btn">Create a Queue</button>
      </div>
    `;
    el.querySelector('#new-queue')?.addEventListener('click', () => {
      alert('Open: Queue creation flow');
      // TODO: route to /host/queues/new or open modal
    });
  }
};
