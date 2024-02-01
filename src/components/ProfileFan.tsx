import { useState, useEffect } from "react";
import RedeemedRelease from "./RedeemedRelease";
import {
  getRelease,
} from "../firebase";

type ProfileFanProps = {
  fanProfile: any;
};

const ProfileFan: React.FC<ProfileFanProps> = ({ fanProfile }) => {
  const [redeemed, setRedeemed] = useState<any[]>([]);

  const sortReleasesByDate = (a: any, b: any) => {
    return (
      new Date(b.releaseDate).getTime() - new Date(a.releaseDate).getTime()
    );
  };

  useEffect(() => {
    const fetchRedeemed = async () => {
      if (!fanProfile?.redeemed) return;
      const redeemedData = await Promise.all(
        fanProfile.redeemed.map(async (redeemedItem: any) => {
          const release = await getRelease(redeemedItem.releaseId);
          return { ...release, code: redeemedItem.code };
        })
      );
      redeemedData.sort(sortReleasesByDate);
      setRedeemed(redeemedData);
    };

    fetchRedeemed();
  }, [fanProfile?.redeemed]);

  return (
    <>
    {redeemed && (
        <div className="flex flex-col items-center text-accent mb-5">
          <h2 className="text-4xl font-bold m-5">My Redeemed Releases</h2>
          <div className="flex flex-wrap items-center justify-center">
            {redeemed.map((release: any) => (
              <RedeemedRelease release={release} key={release.name} />
            ))}
          </div>
        </div>
      )}
    </>
  )
}

export default ProfileFan;