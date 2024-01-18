import { useNavigate } from "react-router-dom";
import { useEffect } from "react";

type SettingsProps = {
  user: any;
};

const Settings: React.FC<SettingsProps> = ({ user }) => {
  const navigate = useNavigate();

  useEffect(() => {
    if (!user) {
      navigate("/login");
    }
  }, [user]);
  return (
    <div className="flex flex-col items-center justify-center h-screen w-full">
      <h1 className="text-6xl font-bold m-5">Settings</h1>
    </div>
  );
};

export default Settings;
