const Shortcut = () => {
  return (
    <div className="flex flex-col justify-center items-center gap-3 w-full text-xl text-neutral absolute bottom-[75px]">
      <div
        className="flex flex-row justify-center gap-5 tooltip tooltip-open"
        data-tip="Use the arrow keys or swipe left and right to switch between artists!"
      >
        <kbd className="kbd">◀︎</kbd>
        <span className="text-4xl">+</span>
        <kbd className="kbd">▶︎</kbd>
      </div>
    </div>
  );
};

export default Shortcut;
