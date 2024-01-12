import ThemeChanger from "./ThemeChanger";
type HeaderProps = {
  theme: string;
  handleThemeChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  user: any;
};

const Header: React.FC<HeaderProps> = ({ theme, handleThemeChange, user }) => {
  return (
    <header className="navbar bg-neutral text-neutral-content fixed top-0">
      <div className="navbar-start">
        <h1 className="text-2xl ml-5">Code Fanatics</h1>
      </div>
      <div className="navbar-end">
        <ThemeChanger theme={theme} handleThemeChange={handleThemeChange} />
        {user ? (
          <div className="avatar online m-2">
            <div className="w-12 rounded-full">
              <img src="https://daisyui.com/images/stock/photo-1534528741775-53994a69daeb.jpg" />
            </div>
          </div>
        ) : (
          <div className="avatar m-2 placeholder">
            <div className="w-12 rounded-full bg-secondary">
              <span className='text-5xl text-secondary-content'>?</span>
            </div>
          </div>
        )}
      </div>
    </header>
  );
};

export default Header;
