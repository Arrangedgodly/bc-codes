const Shortcut = () => {
  return (
    <div className="flex flex-col gap-3 w-full items-center justify-center text-xl text-neutral absolute top-[100px]">
      <div
        className="flex flex-row justify-center gap-5 tooltip tooltip-primary tooltip-bottom"
        data-tip="Use the arrow keys or swipe left and right to switch between artists!"
      >
        <kbd className="kbd small-text">◀︎</kbd>
        <span className="header-text">+</span>
        <kbd className="kbd small-text">▶︎</kbd>
      </div>
    </div>
  );
};

export default Shortcut;
