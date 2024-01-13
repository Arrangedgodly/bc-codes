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
    <div>
      
    </div>
  )
}

export default Settings;