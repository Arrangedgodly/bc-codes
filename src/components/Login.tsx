import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";

type LoginProps = {
  user: any;
  handleEmailLogin: (email: string, password: string) => void;
  handleGoogleLogin: () => void;
  setUser: any;
};

const Login: React.FC<LoginProps> = ({
  user,
  handleEmailLogin,
  handleGoogleLogin,
  setUser
}) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const navigate = useNavigate();

  const handleEmailChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setEmail(event.target.value);
  };

  const handlePasswordChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setPassword(event.target.value);
  };

  const handleEmail = () => {
    console.log("Handle email clicked")
    const user = handleEmailLogin(email, password);
    console.log("User: ", user)
    if (user !== null) {
      setUser(user);
    }
    console.log("Handle email finished")
  };

  useEffect(() => {
    if (user) {
      navigate("/");
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
      <button
        onClick={handleGoogleLogin}
        className="text-xl btn btn-secondary m-3"
      >
        Login with Google
      </button>
    </div>
  );
};

export default Login;
