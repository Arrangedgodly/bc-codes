import { Link } from "react-router-dom";
import { AvatarProps } from "../types";

const Avatar: React.FC<AvatarProps> = ({ user, handleLogout }) => {
  const getInitials = (name: string) => {
    const names = name.split(" ");
    let initials = "";
    names.forEach((name) => {
      initials += name[0];
    });
    return initials;
  };

  return (
    <details className="dropdown dropdown-end">
      {user ? (
        <>
          <summary className="m-2 btn btn-ghost avatar online">
            <div className="w-10 rounded-full bg-secondary">
              <span className="text-4xl text-secondary-content">
                {getInitials(user.name)}
              </span>
            </div>
          </summary>
          <ul className="p-2 shadow menu dropdown-content z-[1] bg-secondary rounded-box w-35 text-xl text-secondary-content">
            <li className="mx-auto">
              <Link to="/profile">Profile</Link>
            </li>
            <li className="mx-auto">
              <Link to="/" onClick={handleLogout}>
                Logout
              </Link>
            </li>
          </ul>
        </>
      ) : (
        <>
          <summary className="avatar m-2 placeholder btn btn-ghost">
            <div className="w-10 rounded-full bg-secondary">
              <span className="text-4xl text-secondary-content">?</span>
            </div>
          </summary>
          <ul className="p-2 shadow menu dropdown-content z-[1] bg-secondary rounded-box w-35 text-xl text-secondary-content">
            <li className="mx-auto">
              <Link to="/login">Login</Link>
            </li>
            <li className="mx-auto">
              <Link to="/signup">Signup</Link>
            </li>
          </ul>
        </>
      )}
    </details>
  );
};

export default Avatar;
