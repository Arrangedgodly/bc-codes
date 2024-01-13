import { useNavigate } from "react-router-dom";
import { useEffect } from "react";

type ProfileProps = {
  user: any;
};

const Profile: React.FC<ProfileProps> = ({ user }) => {
  const navigate = useNavigate();
  
  useEffect(() => {
    if (!user) {
      navigate("/login");
    }
  }, [user]);

  return (
    <div className="flex flex-col items-center justify-center">
      <h1 className="text-4xl font-bold">Profile</h1>
      <p className="text-2xl font-bold">{user?.email}</p>
    </div>
  )
}

export default Profile;