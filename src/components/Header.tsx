import ThemeChanger from "./ThemeChanger";

const Header = () => {
  return (
    <header className="navbar bg-neutral fixed top-0">
      <div className="navbar-start">
        <h1 className="text-2xl ml-5">Code Fanatics</h1>
      </div>
      <div className="navbar-end">
        <ThemeChanger />
        <div className="avatar online m-2">
          <div className="w-12 rounded-full">
            <img src="https://daisyui.com/images/stock/photo-1534528741775-53994a69daeb.jpg" />
          </div>
        </div>
      </div>
    </header>
  );
}

export default Header;
