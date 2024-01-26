import ThemeChanger from "./ThemeChanger";
import Avatar from "./Avatar";
import { Link } from "react-router-dom";
import Logo from "../codefanatics.svg";

type HeaderProps = {
  theme: string;
  handleThemeChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  user: any;
  handleLogout: () => void;
};

const Header: React.FC<HeaderProps> = ({
  theme,
  handleThemeChange,
  user,
  handleLogout,
}) => {
  return (
    <header className="navbar bg-neutral text-neutral-content fixed top-0">
      <div className="navbar-start">
        <Link className="text-3xl ml-2 flex items-center" to="/">
          <img src={Logo} alt="Code Fanatics" className="w-10 h-10 mr-2" />
          Code Fanatics
        </Link>
      </div>
      <div className="navbar-end">
        <ThemeChanger theme={theme} handleThemeChange={handleThemeChange} />
        <Avatar user={user} handleLogout={handleLogout} />
      </div>
    </header>
  );
};

export default Header;
