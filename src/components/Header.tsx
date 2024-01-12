import ThemeChanger from "./ThemeChanger";
import logo from "../../public/logo.svg";

type HeaderProps = {
  theme: string;
  handleThemeChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
};

const Header: React.FC<HeaderProps> = ({ theme, handleThemeChange }) => {
  return (
    <header className="navbar bg-neutral text-neutral-content fixed top-0">
      <div className="navbar-start">
        <svg className="w-12 h-12 fill-rose-500">
          {logo}
        </svg>
        <h1 className="text-2xl ml-5">Code Fanatics</h1>
      </div>
      <div className="navbar-end">
        <ThemeChanger theme={theme} handleThemeChange={handleThemeChange} />
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
