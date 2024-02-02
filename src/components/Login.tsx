import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { emailLogin, googleLogin } from "../firebase";
import Popup from "./Popup";

type LoginProps = {
  user: any;
};

const Login: React.FC<LoginProps> = ({ user }) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<boolean>(false);
  const navigate = useNavigate();

  const handleEmailChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setEmail(event.target.value);
    setError(false);
  };

  const handlePasswordChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setPassword(event.target.value);
    setError(false);
  };

  const handleEmail = () => {
    emailLogin(email, password).catch(() => setError(true));
  };

  useEffect(() => {
    if (user) {
      navigate("/profile");
    }
  }, [user]);

  return (
    <div className="h-screen w-full flex flex-col items-center justify-center">
      <h2 className="text-5xl m-3">Login</h2>
      <div className="text-2xl m-3 flex flex-col">
        <label>Email:</label>
        <input
          type="email"
          value={email}
          onChange={handleEmailChange}
          className="p-2 w-[300px] text-center"
        />
      </div>
      <div className="text-2xl m-3 flex flex-col">
        <label>Password:</label>
        <input
          type="password"
          value={password}
          onChange={handlePasswordChange}
          className="p-2 w-[300px] text-center"
        />
      </div>
      <button onClick={handleEmail} className="text-xl btn btn-accent m-3">
        Login with Email/Password
      </button>
      <button onClick={googleLogin} className="text-xl btn btn-secondary m-3">
        Login with Google
      </button>
      {error && <Popup text="Invalid Email or Password" version="error" />}
    </div>
  );
};

export default Login;
