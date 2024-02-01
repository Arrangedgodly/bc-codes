const Shortcut = () => {
  return (
    <>
    <input type="checkbox" id="shortcut" className="modal-toggle" />
    <div className="modal" role="dialog">
      <div className="modal-box flex flex-col gap-3 w-full items-center justify-center text-xl text-neutral absolute top-[100px] h-1/2">
        <div
          className="flex flex-row justify-center gap-5"
        >
          <kbd className="kbd mid-text">◀︎</kbd>
          <span className="main-text">+</span>
          <kbd className="kbd mid-text">▶︎</kbd>
        </div>
        <p className="text-center">
          Use the left and right arrow keys to navigate between artists!
        </p>
      </div>
      <label className="modal-backdrop" htmlFor="shortcut">Close</label>
    </div>
    </>
  );
};

export default Shortcut;
