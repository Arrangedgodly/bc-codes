const Shortcut = () => {
  return (
    <div className="flex flex-col justify-center items-center gap-3 w-full text-xl text-neutral absolute bottom-[10%]">
      <div className="w-[25%] text-center">
        Use the arrow keys or swipe left and right to switch between artists
      </div>
      <div className="flex flex-row justify-center gap-5">
        <kbd className="kbd">◀︎</kbd>
        <span className="text-4xl">+</span>
        <kbd className="kbd">▶︎</kbd>
      </div>
    </div>
  );
};

export default Shortcut;
